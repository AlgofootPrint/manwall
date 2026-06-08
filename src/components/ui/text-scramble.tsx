import { useEffect, useRef, useState } from "react";

const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#@$%&";

type TextScrambleProps = {
  text: string;
  className?: string;
};

export function TextScramble({ text, className = "" }: TextScrambleProps) {
  const [display, setDisplay] = useState(text);
  const frame = useRef(0);

  function scramble() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    cancelAnimationFrame(frame.current);
    const started = performance.now();
    const duration = 650;

    const animate = (now: number) => {
      const progress = Math.min((now - started) / duration, 1);
      const resolved = Math.floor(progress * text.length);
      setDisplay(
        text
          .split("")
          .map((letter, index) => {
            if (letter === " " || index < resolved) return letter;
            return characters[Math.floor(Math.random() * characters.length)];
          })
          .join("")
      );
      if (progress < 1) frame.current = requestAnimationFrame(animate);
      else setDisplay(text);
    };

    frame.current = requestAnimationFrame(animate);
  }

  useEffect(() => {
    const timer = window.setTimeout(scramble, 450);
    return () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame.current);
    };
  }, [text]);

  return (
    <span
      className={`text-scramble ${className}`}
      tabIndex={0}
      onMouseEnter={scramble}
      onFocus={scramble}
      aria-label={text}
    >
      {display}
    </span>
  );
}
