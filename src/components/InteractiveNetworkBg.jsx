import { useEffect, useRef } from 'react';
import { useOptions } from '../utils/optionsContext';

const InteractiveNetworkBg = () => {
  const canvasRef = useRef(null);
  const { options } = useOptions();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const mouse = { x: -9999, y: -9999 };
    let rafId = 0;

    const lineRgb = (options.bgDesignColor || '95, 15, 24').split(',').map((v) => Number(v.trim()));
    const lineColor = `rgb(${lineRgb[0] || 95}, ${lineRgb[1] || 15}, ${lineRgb[2] || 24})`;
    const pointColor = 'rgba(255,255,255,0.72)';

    const points = [];
    const desiredCount = () => Math.max(70, Math.floor((window.innerWidth * window.innerHeight) / 20000));

    const resize = () => {
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;

      const target = desiredCount();
      if (points.length < target) {
        for (let i = points.length; i < target; i += 1) {
          points.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            vx: (Math.random() - 0.5) * 0.55,
            vy: (Math.random() - 0.5) * 0.55,
          });
        }
      } else if (points.length > target) {
        points.length = target;
      }
    };

    const onMove = (e) => {
      mouse.x = e.clientX * dpr;
      mouse.y = e.clientY * dpr;
    };

    const onLeave = () => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    const step = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const maxDist = 180 * dpr;
      const maxDistSq = maxDist * maxDist;
      const hoverDist = 170 * dpr;
      const hoverDistSq = hoverDist * hoverDist;

      for (let i = 0; i < points.length; i += 1) {
        const p = points[i];

        // Mouse influence: subtle push/pull while preserving network cohesion.
        const mdx = p.x - mouse.x;
        const mdy = p.y - mouse.y;
        const md2 = mdx * mdx + mdy * mdy;
        if (md2 < hoverDistSq) {
          const force = (hoverDistSq - md2) / hoverDistSq;
          const inv = 1 / Math.max(Math.sqrt(md2), 1);
          p.vx += mdx * inv * force * 0.07;
          p.vy += mdy * inv * force * 0.07;
        }

        p.vx *= 0.985;
        p.vy *= 0.985;
        p.x += p.vx;
        p.y += p.vy;

        if (p.x <= 0 || p.x >= canvas.width) p.vx *= -1;
        if (p.y <= 0 || p.y >= canvas.height) p.vy *= -1;

        if (p.x < 0) p.x = 0;
        if (p.x > canvas.width) p.x = canvas.width;
        if (p.y < 0) p.y = 0;
        if (p.y > canvas.height) p.y = canvas.height;
      }

      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];

        for (let j = i + 1; j < points.length; j += 1) {
          const b = points[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > maxDistSq) continue;

          const alpha = 1 - d2 / maxDistSq;
          ctx.strokeStyle = `rgba(${lineRgb[0] || 95}, ${lineRgb[1] || 15}, ${lineRgb[2] || 24}, ${0.26 * alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }

        ctx.fillStyle = pointColor;
        ctx.beginPath();
        ctx.arc(a.x, a.y, 1.25 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }

      // Light star field for depth
      for (let i = 0; i < 36; i += 1) {
        const sx = ((i * 9973) % canvas.width);
        const sy = ((i * 4451 + Date.now() * 0.01) % canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(sx, sy, 1.3 * dpr, 1.3 * dpr);
      }

      rafId = requestAnimationFrame(step);
    };

    resize();
    step();

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, [options.bgDesignColor]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        opacity: 0.95,
      }}
      aria-hidden="true"
    />
  );
};

export default InteractiveNetworkBg;