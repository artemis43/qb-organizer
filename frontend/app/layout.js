// qb-organizer/frontend/app/layout.js
import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "QB Organizer — MBBS Companion",
  description: "Internal tool for organizing medical question banks from textbooks and exam papers",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <div className="app-layout">
          <Sidebar />
          <main className="main-content">{children}</main>
        </div>
      </body>
    </html>
  );
}

function Sidebar() {
  const navItems = [
    { href: "/", icon: "📊", label: "Dashboard" },
    { href: "/textbooks", icon: "📕", label: "Textbooks" },
    { href: "/papers", icon: "📄", label: "Question Papers" },
    { href: "/review", icon: "🔍", label: "Review Center" },
    { href: "/answers", icon: "✍️", label: "Answers" },
    { href: "/viva", icon: "🎤", label: "Viva Organizer" },
    { href: "/knowledge", icon: "🕸️", label: "Knowledge Graph" },
    { href: "/export", icon: "🚀", label: "Deploy" },
    { href: "/settings", icon: "⚙️", label: "Settings" },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <div className="sidebar-logo-icon">🧠</div>
        <span className="sidebar-logo-text">QB Organizer</span>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <Link key={item.href} href={item.href} className="nav-link">
            <span className="nav-link-icon">{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div style={{ fontSize: "11px", color: "var(--text-dim)", padding: "8px 14px", fontFamily: "var(--mono)" }}>
          MBBS Companion v1.0
        </div>
      </div>
    </aside>
  );
}
