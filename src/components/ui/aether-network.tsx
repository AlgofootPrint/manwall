import { useEffect, useRef } from "react";

type AetherNetworkProps = React.ComponentProps<"canvas"> & {
  color?: string;
  highlightColor?: string;
};

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
};

export function AetherNetwork({
  color = "166, 244, 197",
  highlightColor = "240, 239, 234",
  className = "",
  ...props
}: AetherNetworkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = canvas?.parentElement;
    const context = canvas?.getContext("2d");
    if (!canvas || !container || !context) return;

    const particles: Particle[] = [];
    const pointer = { x: -1000, y: -1000, radius: 260 };
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    let clearTimer = 0;

    const initialize = () => {
      const bounds = container.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio, 1.75);
      width = bounds.width;
      height = bounds.height;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      particles.length = 0;
      const count = Math.min(115, Math.max(45, Math.floor((width * height) / 10500)));
      for (let index = 0; index < count; index++) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.24,
          vy: (Math.random() - 0.5) * 0.24,
          radius: 1 + Math.random() * 1.35
        });
      }
    };

    const draw = () => {
      context.clearRect(0, 0, width, height);

      for (const particle of particles) {
        if (!reducedMotion) {
          const dx = pointer.x - particle.x;
          const dy = pointer.y - particle.y;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < pointer.radius) {
            const force = (pointer.radius - distance) / pointer.radius;
            particle.x -= (dx / distance) * force * 1.6;
            particle.y -= (dy / distance) * force * 1.6;
          }
          particle.x += particle.vx;
          particle.y += particle.vy;
          if (particle.x < 0 || particle.x > width) particle.vx *= -1;
          if (particle.y < 0 || particle.y > height) particle.vy *= -1;
        }

        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(${color}, .72)`;
        context.fill();
      }

      const threshold = Math.min(155, width / 6);
      for (let first = 0; first < particles.length; first++) {
        for (let second = first + 1; second < particles.length; second++) {
          const a = particles[first];
          const b = particles[second];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          if (distance >= threshold) continue;
          const pointerDistanceA = Math.hypot(a.x - pointer.x, a.y - pointer.y);
          const pointerDistanceB = Math.hypot(b.x - pointer.x, b.y - pointer.y);
          const pointerDistance = Math.min(pointerDistanceA, pointerDistanceB);
          const active = pointerDistance < pointer.radius;
          const emphasis = active ? 1 - pointerDistance / pointer.radius : 0;
          const opacity = (1 - distance / threshold) * (active ? 0.16 + emphasis * 0.92 : 0.2);
          context.strokeStyle = `rgba(${color}, ${opacity})`;
          context.lineWidth = active ? 0.8 + emphasis * 1.4 : 0.5;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }
      }

      const pointerActive = pointer.x >= 0 && pointer.y >= 0;
      if (pointerActive) {
        for (const particle of particles) {
          const distance = Math.hypot(pointer.x - particle.x, pointer.y - particle.y);
          if (distance >= pointer.radius) continue;
          const emphasis = 1 - distance / pointer.radius;
          context.strokeStyle = `rgba(${color}, ${0.25 + emphasis * 0.85})`;
          context.lineWidth = 0.7 + emphasis * 1.9;
          context.beginPath();
          context.moveTo(pointer.x, pointer.y);
          context.lineTo(particle.x, particle.y);
          context.stroke();
        }
      }

      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };

    const updatePointer = (clientX: number, clientY: number) => {
      window.clearTimeout(clearTimer);
      const bounds = canvas.getBoundingClientRect();
      const x = clientX - bounds.left;
      const y = clientY - bounds.top;
      if (x < 0 || x > bounds.width || y < 0 || y > bounds.height) {
        pointer.x = -1000;
        pointer.y = -1000;
        return;
      }
      pointer.x = x;
      pointer.y = y;
    };
    const handlePointer = (event: PointerEvent) => updatePointer(event.clientX, event.clientY);
    const handleTouch = (event: TouchEvent) => {
      const touch = event.touches[0] ?? event.changedTouches[0];
      if (touch) updatePointer(touch.clientX, touch.clientY);
    };
    const clearPointer = (delay = 0) => {
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(() => {
        pointer.x = -1000;
        pointer.y = -1000;
      }, delay);
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType === "touch") clearPointer(180);
    };
    const handleTouchEnd = () => {
      clearPointer(180);
    };
    const handleWindowLeave = () => {
      pointer.x = -1000;
      pointer.y = -1000;
    };

    const observer = new ResizeObserver(() => {
      initialize();
      if (reducedMotion) draw();
    });
    observer.observe(container);
    window.addEventListener("pointerdown", handlePointer, { passive: true });
    window.addEventListener("pointermove", handlePointer);
    window.addEventListener("pointerup", handlePointerEnd, { passive: true });
    window.addEventListener("pointercancel", handlePointerEnd, { passive: true });
    window.addEventListener("touchstart", handleTouch, { passive: true });
    window.addEventListener("touchmove", handleTouch, { passive: true });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
    document.documentElement.addEventListener("mouseleave", handleWindowLeave);
    initialize();
    draw();

    return () => {
      observer.disconnect();
      window.clearTimeout(clearTimer);
      window.removeEventListener("pointerdown", handlePointer);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      window.removeEventListener("touchstart", handleTouch);
      window.removeEventListener("touchmove", handleTouch);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
      document.documentElement.removeEventListener("mouseleave", handleWindowLeave);
      cancelAnimationFrame(frame);
    };
  }, [color, highlightColor]);

  return <canvas ref={canvasRef} className={`aether-network ${className}`} aria-hidden="true" {...props} />;
}
