'use client';

import { useEffect, useState } from 'react';
import { apiRaw } from '@/lib/client/api';
import { useI18n } from '@/components/mini-app/i18n-context';

/**
 * A person's photo, or their initial when there is none. Photos sit behind sign-in, so
 * the image is fetched with the session token and shown from memory rather than by URL.
 * `version` changes when the photo does, which triggers a fresh fetch.
 */
export function Avatar({ src, version, name, size = 48 }: { src: string; version: string | null; name: string; size?: number }) {
  const { locale } = useI18n();
  const [loaded, setLoaded] = useState<{ key: string; url: string } | null>(null);
  const key = version ? `${src}#${version}` : '';

  useEffect(() => {
    if (!key) return;
    let live = true;
    let url = '';
    apiRaw(src, { locale })
      .then((r) => r.blob())
      .then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setLoaded({ key, url });
      })
      .catch(() => {});
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
    // The language does not change the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, src]);

  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  if (key && loaded?.key === key) {
    // eslint-disable-next-line @next/next/no-img-element -- an in-memory blob, not a file next/image can optimise
    return <img src={loaded.url} alt={name} style={style} className="shrink-0 rounded-full object-cover" />;
  }
  return (
    <span aria-hidden="true" style={style} className="flex shrink-0 items-center justify-center rounded-full bg-pale font-semibold">
      {[...name][0]}
    </span>
  );
}
