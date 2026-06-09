import { useEffect, useRef } from "react";
import * as THREE from "three";

type DottedSurfaceProps = React.ComponentProps<"div">;

export function DottedSurface({ className = "", ...props }: DottedSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0f0f11, 900, 5200);

    const camera = new THREE.PerspectiveCamera(55, 1, 1, 6000);
    camera.position.set(0, 420, 1250);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(scene.fog.color, 0);
    container.appendChild(renderer.domElement);

    const amountX = 44;
    const amountY = 54;
    const separation = 115;
    const positions: number[] = [];

    for (let x = 0; x < amountX; x += 1) {
      for (let y = 0; y < amountY; y += 1) {
        positions.push(
          x * separation - (amountX * separation) / 2,
          0,
          y * separation - (amountY * separation) / 2
        );
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xa6f4c5,
      size: 5,
      transparent: true,
      opacity: 0.42,
      sizeAttenuation: true
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let count = 0;
    let animationId = 0;

    const render = () => {
      const attribute = geometry.attributes.position as THREE.BufferAttribute;
      const values = attribute.array as Float32Array;
      let point = 0;

      for (let x = 0; x < amountX; x += 1) {
        for (let y = 0; y < amountY; y += 1) {
          values[point * 3 + 1] =
            Math.sin((x + count) * 0.28) * 48 +
            Math.sin((y + count) * 0.42) * 48;
          point += 1;
        }
      }

      attribute.needsUpdate = true;
      renderer.render(scene, camera);
    };

    const animate = () => {
      render();
      count += 0.045;
      animationId = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      if (reducedMotion) render();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();
    if (!reducedMotion) animate();

    return () => {
      resizeObserver.disconnect();
      window.cancelAnimationFrame(animationId);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={containerRef} className={`dotted-surface ${className}`.trim()} {...props} />;
}
