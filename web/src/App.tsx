// Phase-1 scaffold placeholder. Just a centered banner so we can
// verify Vite + Tailwind + the token CSS all wire correctly. The
// real entry is the Desktop component (next step), which mounts the
// agent-dock + window-manager + chat windows.

export default function App() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-accent">somora</h1>
        <p className="text-text-2 mt-2 font-mono text-xs tracking-wider uppercase">
          web — phase 1 scaffold
        </p>
        <p className="text-text-3 mt-4 text-xs max-w-md mx-auto">
          Build pipeline online. The desktop, agent-dock, and chat-windows
          land in the next iteration; this page exists only to confirm the
          tokens, fonts, and Tailwind plumbing.
        </p>
      </div>
    </div>
  );
}
