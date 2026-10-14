'use client';

import { useEffect, useRef, useState } from 'react';

type AnimationData = { assets?: { id?: string; u?: string; p?: string; e?: number }[] } & Record<string, unknown>;

/**
 * Plays a Lottie animation served from this site (`.lottie` or `.json`). The player and the
 * unzipper load only when an animation is on screen. Decorative: hidden from screen readers,
 * shown as a still first frame for people who ask for reduced motion, and simply absent if the
 * file is missing or cannot be read.
 */
export function LottieAnimation({ src, className = '' }: { src: string; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let destroyed = false;
    let stop: (() => void) | undefined;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok) throw new Error(String(res.status));
        const data = src.endsWith('.json') ? ((await res.json()) as AnimationData) : await unpack(new Uint8Array(await res.arrayBuffer()));
        const { default: lottie } = await import('lottie-web/build/player/lottie_light');
        if (destroyed) return;
        const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const anim = lottie.loadAnimation({ container: el, renderer: 'svg', loop: !still, autoplay: !still, animationData: data });
        if (still) anim.goToAndStop(0, true);
        stop = () => anim.destroy();
      } catch {
        if (!destroyed) setFailed(true);
      }
    })();
    return () => {
      destroyed = true;
      stop?.();
    };
  }, [src]);

  if (failed) return null;
  return <div ref={host} aria-hidden="true" className={className} />;
}

/** A .lottie file is a zip: manifest.json, animations/<id>.json and any images it uses. */
async function unpack(zip: Uint8Array): Promise<AnimationData> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(zip);
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as { animations?: { id: string }[] };
  const id = manifest.animations?.[0]?.id;
  const path = id ? `animations/${id}.json` : Object.keys(files).find((f) => f.startsWith('animations/') && f.endsWith('.json'));
  if (!path || !files[path]) throw new Error('no animation in file');
  const data = JSON.parse(strFromU8(files[path])) as AnimationData;
  // Images packed in the archive are inlined, so the player never fetches anything else.
  for (const asset of data.assets ?? []) {
    if (!asset.p || asset.e === 1) continue;
    const bytes = files[`images/${asset.p}`];
    if (!bytes) continue;
    const type = asset.p.endsWith('.png') ? 'image/png' : asset.p.endsWith('.webp') ? 'image/webp' : asset.p.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    asset.u = '';
    asset.p = `data:${type};base64,${btoa(binary)}`;
    asset.e = 1;
  }
  return data;
}
