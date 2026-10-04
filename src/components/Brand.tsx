import Image from 'next/image';

/**
 * The three forms of the logo and where each belongs:
 * - long: icon and wordmark side by side, for headers and the printed QR sheet;
 * - mark: the icon alone, where space is tight (phone headers);
 * - stacked: icon over wordmark on white, for sign-in and loading screens.
 * The source artwork is in /media; the sized copies here are generated from it.
 */
const SRC = {
  long: { src: '/brand/logo-long.png', ratio: 655 / 120 },
  mark: { src: '/brand/mark.png', ratio: 1 },
  stacked: { src: '/brand/logo-stacked.png', ratio: 567 / 520 },
} as const;

export const BRAND_NAME = 'TovTamMog';

export function Brand({ form, height, className = '', priority }: { form: keyof typeof SRC; height: number; className?: string; priority?: boolean }) {
  const { src, ratio } = SRC[form];
  return (
    <Image
      src={src}
      alt={BRAND_NAME}
      width={Math.round(height * ratio)}
      height={height}
      priority={priority}
      className={`h-auto max-w-full shrink-0 ${className}`}
      style={{ width: Math.round(height * ratio) }}
    />
  );
}
