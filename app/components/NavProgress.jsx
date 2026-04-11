// ═══════════════════════════════════════════════════════════════════
// Importzo — Navigation Progress
// Thin top bar that appears during route navigation and initial
// hydration. Replaces the brief "broken layout" flash with a clear,
// intentional loading affordance.
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { useNavigation } from "react-router";

const PRIMARY = "#17320A";
const SECONDARY = "#2E6316";

export function NavProgress() {
  const navigation = useNavigation();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer;
    if (navigation.state !== "idle") {
      // Tiny delay — avoids flashes on very fast transitions
      timer = setTimeout(() => setVisible(true), 80);
    } else {
      setVisible(false);
    }
    return () => timer && clearTimeout(timer);
  }, [navigation.state]);

  if (!visible) return null;

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 z-[9999] pointer-events-none"
      style={{ height: 3 }}
    >
      <div
        className="h-full w-1/3 animate-progress"
        style={{
          background: `linear-gradient(90deg, transparent 0%, ${SECONDARY} 30%, ${PRIMARY} 70%, transparent 100%)`,
          boxShadow: `0 0 12px rgba(46,99,22,0.5)`,
        }}
      />
    </div>
  );
}
