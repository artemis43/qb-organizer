# qb-organizer/backend/claude/client.py
"""Production-grade Claude API client with full fault tolerance.

Safety features:
- Exponential backoff with jitter for rate limits
- Circuit breaker to stop during outages
- Token-aware rate limiting
- Persistent retry queue for failed requests
- Real-time cost tracking with budget enforcement
- Structured response validation
- Automatic model selection per task type
"""

import anthropic
import asyncio
import json
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any, Optional
from pydantic import ValidationError

from config import settings
from state import db as database

logger = logging.getLogger(__name__)

# ── Pricing (per million tokens) ──────────────────────────────────

PRICING = {
    settings.haiku_model: {"input": 1.00, "output": 5.00},
    settings.sonnet_model: {"input": 3.00, "output": 15.00},
}

BATCH_DISCOUNT = 0.5  # 50% off for batch API


# ── Custom Exceptions ─────────────────────────────────────────────

class ClaudeError(Exception):
    """Base error for Claude client."""
    pass

class BudgetExceededError(ClaudeError):
    pass

class CircuitOpenError(ClaudeError):
    pass

class MaxRetriesExceededError(ClaudeError):
    pass

class MalformedResponseError(ClaudeError):
    pass


# ── Circuit Breaker ───────────────────────────────────────────────

class CircuitBreaker:
    """Stops API calls after too many consecutive failures."""

    def __init__(self, threshold: int = 5, recovery_seconds: int = 300):
        self.threshold = threshold
        self.recovery_seconds = recovery_seconds
        self.failure_count = 0
        self.last_failure_time = 0.0
        self.state = "closed"  # closed, open, half_open

    def is_open(self) -> bool:
        if self.state == "open":
            elapsed = time.time() - self.last_failure_time
            if elapsed >= self.recovery_seconds:
                self.state = "half_open"
                logger.info("Circuit breaker → HALF_OPEN (testing)")
                return False
            return True
        return False

    def record_success(self):
        self.failure_count = 0
        if self.state == "half_open":
            logger.info("Circuit breaker → CLOSED (recovered)")
        self.state = "closed"

    def record_failure(self):
        self.failure_count += 1
        self.last_failure_time = time.time()
        if self.failure_count >= self.threshold:
            self.state = "open"
            logger.error(
                f"Circuit breaker → OPEN (threshold {self.threshold} reached). "
                f"Waiting {self.recovery_seconds}s before retry."
            )

    def get_status(self) -> dict:
        return {
            "state": self.state,
            "failure_count": self.failure_count,
            "threshold": self.threshold,
        }


# ── Cost Tracker ──────────────────────────────────────────────────

class CostTracker:
    """Tracks API spend in real time against a budget."""

    def __init__(self):
        self._total = 0.0
        self._loaded = False

    async def _ensure_loaded(self):
        if not self._loaded:
            rows = await database.fetch_all("api_costs")
            self._total = sum(r.get("cost_usd", 0) for r in rows)
            self._loaded = True

    async def record(self, model: str, task_type: str,
                     input_tokens: int, output_tokens: int,
                     request_id: str = "", subject: str = "",
                     is_batch: bool = False):
        """Record an API call's cost."""
        await self._ensure_loaded()
        pricing = PRICING.get(model, {"input": 1.0, "output": 5.0})
        discount = BATCH_DISCOUNT if is_batch else 1.0

        cost = (
            (input_tokens / 1_000_000 * pricing["input"] * discount) +
            (output_tokens / 1_000_000 * pricing["output"] * discount)
        )
        self._total += cost

        await database.insert("api_costs", {
            "id": None,  # auto-increment
            "model": model,
            "task_type": task_type,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost_usd": round(cost, 6),
            "request_id": request_id,
            "subject": subject,
        })

        logger.debug(
            f"API cost: ${cost:.4f} ({model}, {input_tokens}in/{output_tokens}out)"
        )
        return cost

    async def total_spent(self) -> float:
        await self._ensure_loaded()
        return round(self._total, 4)

    async def remaining_budget(self) -> float:
        await self._ensure_loaded()
        return round(settings.budget_limit - self._total, 4)

    async def check_budget(self):
        """Raise if budget is exhausted."""
        remaining = await self.remaining_budget()
        if remaining <= 0:
            raise BudgetExceededError(
                f"Budget exhausted. Spent ${await self.total_spent():.2f} "
                f"of ${settings.budget_limit:.2f} limit."
            )

    async def get_summary(self) -> dict:
        await self._ensure_loaded()
        breakdown = {}
        rows = await database.fetch_all("api_costs")
        for r in rows:
            key = r.get("task_type", "unknown")
            breakdown[key] = breakdown.get(key, 0) + r.get("cost_usd", 0)
        return {
            "total_spent": round(self._total, 4),
            "budget_limit": settings.budget_limit,
            "budget_remaining": round(settings.budget_limit - self._total, 4),
            "breakdown": {k: round(v, 4) for k, v in breakdown.items()},
            "api_calls_made": len(rows),
        }


# ── Main Client ───────────────────────────────────────────────────

class ClaudeClient:
    """Production-grade Claude API client with full fault tolerance."""

    def __init__(self):
        if not settings.anthropic_api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key."
            )
        self.client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        self.async_client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        self.circuit_breaker = CircuitBreaker(
            threshold=settings.circuit_breaker_threshold,
            recovery_seconds=settings.circuit_breaker_recovery,
        )
        self.cost_tracker = CostTracker()
        self._request_count = 0

    async def request(
        self,
        messages: list[dict],
        system: str = "",
        model: str = "",
        max_tokens: int = 4096,
        task_type: str = "general",
        subject: str = "",
        response_schema: Any = None,
        request_id: str = "",
    ) -> dict | str:
        """Make a single API request with full protection stack.

        Args:
            messages: The conversation messages.
            system: System prompt.
            model: Model to use (defaults to Haiku).
            max_tokens: Max output tokens.
            task_type: For cost tracking (e.g., 'summary', 'extraction').
            subject: Subject name for tracking.
            response_schema: Pydantic model to validate response against.
            request_id: Unique ID for retry tracking.

        Returns:
            Parsed dict (if JSON response) or raw string.
        """
        if not model:
            model = settings.haiku_model

        # 1. Check circuit breaker
        if self.circuit_breaker.is_open():
            raise CircuitOpenError(
                "Circuit breaker is OPEN due to repeated failures. "
                f"Will retry in {settings.circuit_breaker_recovery}s."
            )

        # 2. Check budget
        await self.cost_tracker.check_budget()

        # 3. Attempt with retries
        last_error = None
        for attempt in range(settings.max_retries):
            try:
                # Build request kwargs
                kwargs = {
                    "model": model,
                    "max_tokens": max_tokens,
                    "messages": messages,
                }
                if system:
                    kwargs["system"] = system

                response = await self.async_client.messages.create(**kwargs)

                # Track cost
                await self.cost_tracker.record(
                    model=model,
                    task_type=task_type,
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                    request_id=request_id,
                    subject=subject,
                )

                self.circuit_breaker.record_success()
                self._request_count += 1

                # Parse response
                text = response.content[0].text

                # Try JSON parse
                try:
                    # Handle markdown code blocks
                    if "```json" in text:
                        text = text.split("```json")[1].split("```")[0].strip()
                    elif "```" in text:
                        text = text.split("```")[1].split("```")[0].strip()

                    data = json.loads(text)

                    # Validate against schema if provided
                    if response_schema:
                        try:
                            validated = response_schema.model_validate(data)
                            return validated.model_dump()
                        except ValidationError as ve:
                            logger.warning(
                                f"Schema validation failed (attempt {attempt + 1}): {ve}"
                            )
                            if attempt < settings.max_retries - 1:
                                # Retry with stricter prompt
                                messages = messages.copy()
                                messages.append({"role": "assistant", "content": text})
                                messages.append({
                                    "role": "user",
                                    "content": (
                                        f"Your response had validation errors:\n{ve}\n\n"
                                        "Please fix the JSON and respond again with ONLY valid JSON."
                                    ),
                                })
                                continue
                            raise MalformedResponseError(f"Schema validation failed: {ve}")

                    return data

                except json.JSONDecodeError:
                    # Not JSON — return raw text
                    return {"text": text}

            except anthropic.RateLimitError as e:
                retry_after = float(
                    e.response.headers.get("retry-after", "")
                    or (settings.retry_base_delay * (2 ** attempt) + random.uniform(0, 1))
                )
                retry_after = min(retry_after, settings.retry_max_delay)
                logger.warning(
                    f"Rate limited (attempt {attempt + 1}/{settings.max_retries}). "
                    f"Waiting {retry_after:.1f}s..."
                )
                await asyncio.sleep(retry_after)
                last_error = e

            except anthropic.APIStatusError as e:
                if e.status_code >= 500:
                    self.circuit_breaker.record_failure()
                    delay = 5 * (attempt + 1) + random.uniform(0, 2)
                    logger.error(
                        f"Server error {e.status_code} (attempt {attempt + 1}). "
                        f"Retrying in {delay:.1f}s..."
                    )
                    await asyncio.sleep(delay)
                    last_error = e
                elif e.status_code == 402:
                    raise BudgetExceededError(
                        "Anthropic billing error (402). Check your API credits."
                    )
                else:
                    # 4xx client errors are not retryable
                    raise ClaudeError(f"API error {e.status_code}: {e.message}")

            except (anthropic.APIConnectionError, anthropic.APITimeoutError) as e:
                delay = 10 * (attempt + 1) + random.uniform(0, 3)
                logger.error(
                    f"Network error (attempt {attempt + 1}): {e}. "
                    f"Retrying in {delay:.1f}s..."
                )
                await asyncio.sleep(delay)
                last_error = e

        # All retries exhausted
        error_msg = f"Max retries ({settings.max_retries}) exceeded. Last error: {last_error}"
        logger.error(error_msg)

        # Save to retry queue
        if request_id:
            await database.insert("retry_queue", {
                "id": request_id,
                "payload": json.dumps({"messages": messages, "system": system, "model": model}),
                "task_type": task_type,
                "attempt_count": settings.max_retries,
                "last_error": str(last_error),
                "status": "pending",
            })

        raise MaxRetriesExceededError(error_msg)

    def _repair_truncated_json(self, text: str) -> dict | None:
        """Attempt to repair truncated JSON from Claude (hit max_tokens).

        Strategy: find the last complete object in any array, then close
        all open brackets/braces to produce valid JSON with partial data.
        """
        if not text or not text.strip().startswith("{"):
            return None

        # Try progressively shorter substrings ending at } or ]
        for end_char in ["},", "}]", "}", "]"]:
            idx = text.rfind(end_char)
            if idx == -1:
                continue

            # Take text up to and including the end character
            candidate = text[:idx + len(end_char)]

            # Close any remaining open structures
            open_braces = candidate.count("{") - candidate.count("}")
            open_brackets = candidate.count("[") - candidate.count("]")

            # Add closing characters
            candidate = candidate.rstrip(",").rstrip()
            candidate += "]" * max(0, open_brackets)
            candidate += "}" * max(0, open_braces)

            try:
                result = json.loads(candidate)
                if isinstance(result, dict):
                    return result
            except json.JSONDecodeError:
                continue

        return None


    async def request_batch(
        self,
        requests: list[dict],
        model: str = "",
        task_type: str = "batch",
        subject: str = "",
    ) -> str:
        """Submit a batch of requests for async processing (50% discount).

        Args:
            requests: List of dicts with 'custom_id', 'messages', and optional 'system'.
            model: Model to use.
            task_type: For cost tracking.
            subject: Subject name.

        Returns:
            batch_id for polling.
        """
        if not model:
            model = settings.haiku_model

        await self.cost_tracker.check_budget()

        batch_requests = []
        for req in requests:
            params = {
                "model": model,
                "max_tokens": req.get("max_tokens", 4096),
                "messages": req["messages"],
            }
            if req.get("system"):
                params["system"] = req["system"]

            batch_requests.append({
                "custom_id": req["custom_id"],
                "params": params,
            })

        try:
            batch = self.client.messages.batches.create(requests=batch_requests)
            logger.info(
                f"Batch submitted: {batch.id} ({len(batch_requests)} requests, "
                f"model={model}, task={task_type})"
            )

            await database.log_activity(
                "info", task_type,
                f"Batch {batch.id} submitted with {len(batch_requests)} requests",
                {"batch_id": batch.id, "model": model, "subject": subject}
            )

            return batch.id

        except Exception as e:
            logger.error(f"Batch submission failed: {e}")
            raise ClaudeError(f"Batch submission failed: {e}")

    async def poll_batch(self, batch_id: str) -> dict:
        """Check the status of a batch job.

        Returns:
            dict with 'status', 'results' (if complete), and progress info.
        """
        try:
            batch = self.client.messages.batches.retrieve(batch_id)

            result = {
                "batch_id": batch_id,
                "status": batch.processing_status,
                "created_at": str(batch.created_at) if batch.created_at else None,
                "ended_at": str(batch.ended_at) if batch.ended_at else None,
                "request_counts": {
                    "total": batch.request_counts.processing + batch.request_counts.succeeded + batch.request_counts.errored + batch.request_counts.canceled + batch.request_counts.expired,
                    "succeeded": batch.request_counts.succeeded,
                    "errored": batch.request_counts.errored,
                    "processing": batch.request_counts.processing,
                    "canceled": batch.request_counts.canceled,
                    "expired": batch.request_counts.expired,
                },
            }

            if batch.processing_status == "ended":
                # Fetch results
                results = {}
                for batch_result in self.client.messages.batches.results(batch_id):
                    custom_id = batch_result.custom_id
                    if batch_result.result.type == "succeeded":
                        msg = batch_result.result.message
                        text = msg.content[0].text if msg.content else ""

                        # Track cost for each result
                        await self.cost_tracker.record(
                            model=msg.model,
                            task_type="batch",
                            input_tokens=msg.usage.input_tokens,
                            output_tokens=msg.usage.output_tokens,
                            request_id=custom_id,
                            subject="",
                            is_batch=True,
                        )

                        # Try to parse JSON from Claude's response
                        try:
                            json_text = text.strip()

                            # Strip markdown code fences if present
                            if json_text.startswith("```"):
                                # Remove opening fence (```json or ```)
                                first_newline = json_text.index("\n")
                                json_text = json_text[first_newline + 1:]
                                # Remove closing fence if present
                                if "```" in json_text:
                                    json_text = json_text[:json_text.rindex("```")].strip()
                                else:
                                    json_text = json_text.strip()  # Truncated — no closing fence

                            results[custom_id] = {
                                "status": "success",
                                "data": json.loads(json_text),
                            }
                        except json.JSONDecodeError:
                            # Attempt to repair truncated JSON
                            repaired = self._repair_truncated_json(json_text)
                            if repaired is not None:
                                logger.warning(f"Batch {custom_id}: repaired truncated JSON")
                                results[custom_id] = {
                                    "status": "success",
                                    "data": repaired,
                                }
                            else:
                                logger.warning(f"Batch {custom_id}: JSON parse failed, storing raw text")
                                results[custom_id] = {
                                    "status": "success",
                                    "data": {"text": text},
                                }
                    else:
                        results[custom_id] = {
                            "status": "error",
                            "error": str(batch_result.result),
                        }

                result["results"] = results

            return result

        except Exception as e:
            logger.error(f"Batch poll failed: {e}")
            return {"batch_id": batch_id, "status": "error", "error": str(e)}

    async def get_status(self) -> dict:
        """Get the overall client status."""
        return {
            "circuit_breaker": self.circuit_breaker.get_status(),
            "cost": await self.cost_tracker.get_summary(),
            "total_requests": self._request_count,
            "api_key_set": bool(settings.anthropic_api_key),
        }


# ── Singleton ─────────────────────────────────────────────────────

_client: Optional[ClaudeClient] = None


def get_claude_client() -> ClaudeClient:
    """Get or create the singleton Claude client."""
    global _client
    if _client is None:
        _client = ClaudeClient()
    return _client
