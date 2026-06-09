import { useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ComponentProps } from "react";

type FallingPatternProps = ComponentProps<"div"> & {
  color?: string;
  backgroundColor?: string;
  duration?: number;
  blurIntensity?: string;
  density?: number;
};

type PatternStyle = CSSProperties & {
  "--falling-color": string;
  "--falling-background": string;
  "--falling-duration": string;
  "--falling-blur": string;
  "--falling-density": string;
};

export function FallingPattern({
  color = "#a6f4c5",
  backgroundColor = "#0f0f11",
  duration = 80,
  blurIntensity = "0.5rem",
  density = 2,
  className = "",
  style,
  ...props
}: FallingPatternProps) {
  const motionRef = useRef<HTMLDivElement>(null);
  const rowHeights = useMemo(
    () => [235, 252, 150, 253, 204, 134, 179, 299, 215, 281, 158, 210],
    []
  );
  const backgroundImage = useMemo(
    () => rowHeights.flatMap((height, index) => {
      const offset = index * 25;
      return [
        `radial-gradient(4px 100px at ${offset}px ${height}px, ${color}, transparent)`,
        `radial-gradient(4px 100px at ${offset + 300}px ${height}px, ${color}, transparent)`,
        `radial-gradient(1.5px 1.5px at ${offset + 150}px ${height / 2}px, ${color} 100%, transparent 150%)`
      ];
    }).join(", "),
    [color, rowHeights]
  );
  const backgroundSize = useMemo(
    () => rowHeights.flatMap((height) => Array(3).fill(`300px ${height}px`)).join(", "),
    [rowHeights]
  );

  useEffect(() => {
    const motion = motionRef.current;
    if (!motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = motion.animate(
      [
        { backgroundPosition: "0px 0px" },
        { backgroundPosition: "0px 6800px" }
      ],
      { duration: duration * 1000, iterations: Infinity, easing: "linear" }
    );
    return () => animation.cancel();
  }, [duration]);

  const patternStyle: PatternStyle = {
    "--falling-color": color,
    "--falling-background": backgroundColor,
    "--falling-duration": `${duration}s`,
    "--falling-blur": blurIntensity,
    "--falling-density": `${8 * density}px`,
    ...style
  };

  return (
    <div className={`falling-pattern ${className}`.trim()} style={patternStyle} {...props}>
      <div ref={motionRef} className="falling-pattern-motion" style={{ backgroundImage, backgroundSize }} />
      <div className="falling-pattern-filter" />
    </div>
  );
}
