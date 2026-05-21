"use client";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import ForceGraph3D from "react-force-graph-3d";

// Color mapping for concept types
const TYPE_COLORS = {
  disease:       "#f87171",
  anatomy:       "#60a5fa",
  procedure:     "#34d399",
  drug:          "#fbbf24",
  symptom:       "#a78bfa",
  investigation: "#fb923c",
  pathology:     "#ec4899",
  physiology:    "#14b8a6",
  organism:      "#84cc16",
  syndrome:      "#ef4444",
  sign:          "#a855f7",
  condition:     "#eab308",
  concept:       "#94a3b8",
  other:         "#64748b",
};

export default function Graph3D({ nodes, edges, onSelectNode, selectedNodeId, height = 520 }) {
  const fgRef = useRef();
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [showLabels, setShowLabels] = useState(true);
  const [enableParticles, setEnableParticles] = useState(true);
  const [dimensions, setDimensions] = useState({ width: 800, height: typeof height === "number" ? height : 520 });
  const containerRef = useRef(null);

  // Resize handler to fit container
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        const { width, height: observedHeight } = entry.contentRect;
        setDimensions({
          width: width || 800,
          height: observedHeight || (typeof height === "number" ? height : 520),
        });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, [height]);

  // Format data for react-force-graph-3d (shallow clone to prevent mutating react state)
  const graphData = useMemo(() => {
    return {
      nodes: (nodes || []).map((n) => ({ ...n })),
      links: (edges || []).map((e) => ({
        source: e.source,
        target: e.target,
        relation_type: e.relation_type,
        confidence: e.confidence,
      })),
    };
  }, [nodes, edges]);

  // Adjust forces once simulation starts
  useEffect(() => {
    if (!fgRef.current) return;
    // Stronger repulsion for clearer spacing in 3D mesh space
    fgRef.current.d3Force("charge").strength(-120);
    // Link distance
    fgRef.current.d3Force("link").distance(70);
  }, [graphData]);

  // Starfield backdrop effect
  useEffect(() => {
    if (!fgRef.current) return;
    const scene = fgRef.current.scene();
    if (!scene) return;

    // Create a mesh-space background starfield
    const starsGeometry = new THREE.BufferGeometry();
    const starsCount = 800;
    const starPositions = new Float32Array(starsCount * 3);
    for (let i = 0; i < starsCount * 3; i++) {
      starPositions[i] = (Math.random() - 0.5) * 1600;
    }
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    
    // Indigo-tinted glowing points
    const starsMaterial = new THREE.PointsMaterial({
      color: 0x6366f1,
      size: 1.8,
      transparent: true,
      opacity: 0.45,
      sizeAttenuation: true,
    });
    
    const starField = new THREE.Points(starsGeometry, starsMaterial);
    scene.add(starField);

    return () => {
      scene.remove(starField);
      starsGeometry.dispose();
      starsMaterial.dispose();
    };
  }, []);

  // Sync selection change to update node visual styling
  useEffect(() => {
    if (fgRef.current) {
      fgRef.current.refresh();
    }
  }, [selectedNodeId]);

  // Camera Zoom helpers
  const handleZoomIn = () => {
    if (!fgRef.current) return;
    const { x, y, z } = fgRef.current.cameraPosition();
    fgRef.current.cameraPosition({ x: x * 0.75, y: y * 0.75, z: z * 0.75 }, null, 400);
  };

  const handleZoomOut = () => {
    if (!fgRef.current) return;
    const { x, y, z } = fgRef.current.cameraPosition();
    fgRef.current.cameraPosition({ x: x * 1.3, y: y * 1.3, z: z * 1.3 }, null, 400);
  };

  const handleResetCamera = () => {
    if (!fgRef.current) return;
    // Default distant overview coordinate
    fgRef.current.cameraPosition({ x: 0, y: 0, z: 280 }, { x: 0, y: 0, z: 0 }, 1000);
  };

  // Node focus helper
  const handleNodeClick = useCallback(
    (node) => {
      onSelectNode(node.id);
      
      // Calculate camera placement looking directly at the node
      const distance = 80;
      const distRatio = 1 + distance / Math.hypot(node.x, node.y, node.z);
      
      if (fgRef.current) {
        fgRef.current.cameraPosition(
          {
            x: node.x * distRatio,
            y: node.y * distRatio,
            z: node.z * distRatio,
          },
          node, // Look at node target
          1200 // Transition milliseconds
        );
      }
    },
    [onSelectNode]
  );

  // Background clicks reset selection & camera
  const handleBackgroundClick = useCallback(() => {
    onSelectNode(null);
    handleResetCamera();
  }, [onSelectNode]);

  // Node custom object renderer: sphere + halo + crisp text sprite
  const nodeThreeObject = useCallback(
    (node) => {
      const isSel = node.id === selectedNodeId;
      const isHov = node.id === hoveredNodeId;
      const isCtr = node.is_center;
      
      // Map base size according to importance
      const impSize = { must_know: 7.5, standard: 5, advanced: 3.5 };
      const radius = isCtr ? 10 : (impSize[node.importance] || 5);
      const color = TYPE_COLORS[node.concept_type] || TYPE_COLORS.other;

      const group = new THREE.Group();

      // 1. Central sphere
      const sphereGeom = new THREE.SphereGeometry(radius, 24, 24);
      const sphereMat = new THREE.MeshPhongMaterial({
        color: color,
        transparent: true,
        opacity: isSel || isHov ? 0.95 : 0.75,
        shininess: 80,
        emissive: color,
        emissiveIntensity: isSel ? 0.5 : (isHov ? 0.35 : 0.1),
      });
      const sphereMesh = new THREE.Mesh(sphereGeom, sphereMat);
      group.add(sphereMesh);

      // 2. High-Tech wireframe halo for selection or hover
      if (isSel || isHov) {
        const haloGeom = new THREE.SphereGeometry(radius * 1.55, 10, 10);
        const haloMat = new THREE.MeshBasicMaterial({
          color: isSel ? "#ffffff" : color,
          wireframe: true,
          transparent: true,
          opacity: isSel ? 0.35 : 0.2,
        });
        const haloMesh = new THREE.Mesh(haloGeom, haloMat);
        group.add(haloMesh);
      }

      // 3. Crisp text sprite
      if (showLabels || isSel || isHov) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        
        // Oversized canvas dimensions for maximum sharpness (super-sampling)
        canvas.width = 512;
        canvas.height = 120;
        
        ctx.font = "bold 34px 'Inter', sans-serif";
        ctx.fillStyle = isSel ? "#ffffff" : "#e0e7ff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        
        // Add solid drop shadow to text for maximum readability in 3D grid
        ctx.shadowColor = "rgba(4, 4, 15, 0.95)";
        ctx.shadowBlur = 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 2;
        
        // Draw label
        const displayLabel = node.name.length > 24 ? node.name.substring(0, 22) + "…" : node.name;
        ctx.fillText(displayLabel, 256, 45);
        
        // Draw type label underneath
        if (isSel || isHov) {
          ctx.font = "500 20px 'Inter', sans-serif";
          ctx.fillStyle = color;
          ctx.fillText(node.concept_type.toUpperCase(), 256, 85);
        }

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({
          map: texture,
          depthWrite: false, // Prevents sprite background box from cutting off links behind it
        });
        
        const labelSprite = new THREE.Sprite(spriteMat);
        // Position labels above node sphere
        labelSprite.position.set(0, radius + 7, 0);
        labelSprite.scale.set(24, 5.6, 1);
        group.add(labelSprite);
      }

      return group;
    },
    [selectedNodeId, hoveredNodeId, showLabels]
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: height,
        borderRadius: 14,
        overflow: "hidden",
        border: "1px solid rgba(60,60,100,0.3)",
        background: "radial-gradient(circle at center, #0f0f2d 0%, #060614 100%)",
      }}
    >
      {/* 3D Space Controls Toolbar */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          zIndex: 10,
          display: "flex",
          gap: 6,
          background: "rgba(12,12,28,0.88)",
          borderRadius: 10,
          padding: "4px 6px",
          backdropFilter: "blur(8px)",
          border: "1px solid rgba(80,80,120,0.35)",
          boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
        }}
      >
        <button onClick={handleZoomIn} style={toolBtnStyle} title="Zoom In">
          ＋
        </button>
        <button onClick={handleZoomOut} style={toolBtnStyle} title="Zoom Out">
          －
        </button>
        <div style={{ width: 1, background: "rgba(80,80,120,0.3)", margin: "2px 4px" }} />
        <button onClick={handleResetCamera} style={toolBtnStyle} title="Recenter View">
          ⟳
        </button>
        <button
          onClick={() => {
            setShowLabels(!showLabels);
            if (fgRef.current) fgRef.current.refresh();
          }}
          style={{ ...toolBtnStyle, color: showLabels ? "#818cf8" : "#64748b" }}
          title={showLabels ? "Hide All Labels" : "Show All Labels"}
        >
          Aa
        </button>
        <button
          onClick={() => setEnableParticles(!enableParticles)}
          style={{ ...toolBtnStyle, color: enableParticles ? "#34d399" : "#64748b" }}
          title={enableParticles ? "Disable Flows" : "Enable Flows"}
        >
          ✨
        </button>
      </div>

      {/* Mode Overlay HUD */}
      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: 12,
          zIndex: 10,
          fontSize: 10,
          color: "rgba(129, 140, 248, 0.7)",
          fontFamily: "var(--mono)",
          fontWeight: 600,
          letterSpacing: "0.5px",
          background: "rgba(12,12,28,0.6)",
          padding: "3px 8px",
          borderRadius: 6,
        }}
      >
        3D MESH SPACE ENGINE · ACTIVE
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 12,
          right: 12,
          zIndex: 10,
          fontSize: 10,
          color: "rgba(129, 140, 248, 0.7)",
          fontFamily: "var(--mono)",
          fontWeight: 600,
          letterSpacing: "0.5px",
          background: "rgba(12,12,28,0.6)",
          padding: "3px 8px",
          borderRadius: 6,
        }}
      >
        {nodes.length} concepts · {edges.length} relations
      </div>

      {/* 3D Force Graph Render Canvas */}
      <ForceGraph3D
        ref={fgRef}
        width={dimensions.width}
        height={dimensions.height}
        graphData={graphData}
        backgroundColor="#00000000" // Alpha transparent to reveal premium container gradient
        showNavInfo={false}
        
        // Node config
        nodeThreeObject={nodeThreeObject}
        onNodeClick={handleNodeClick}
        onNodeHover={(node) => {
          setHoveredNodeId(node ? node.id : null);
          if (fgRef.current) fgRef.current.refresh();
        }}

        // Link/Edge config
        linkColor={() => "rgba(96, 165, 250, 0.12)"}
        linkWidth={1.2}
        linkDirectionalArrowLength={4}
        linkDirectionalArrowColor={() => "rgba(96, 165, 250, 0.4)"}
        linkDirectionalArrowRelPos={1} // Put arrow head directly at target node edge

        // Premium particle animation flow along relations
        linkDirectionalParticles={enableParticles ? 2 : 0}
        linkDirectionalParticleWidth={1.8}
        linkDirectionalParticleSpeed={0.012}
        linkDirectionalParticleColor={(link) => TYPE_COLORS[link.relation_type] || "#818cf8"}

        // Simulation parameters
        cooldownTicks={100}
        onBackgroundClick={handleBackgroundClick}
      />
    </div>
  );
}

const toolBtnStyle = {
  background: "transparent",
  border: "1px solid rgba(80,80,120,0.3)",
  color: "#aab",
  borderRadius: 6,
  width: 30,
  height: 28,
  cursor: "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "all 0.15s",
};
