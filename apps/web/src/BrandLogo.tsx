/** Shared decorative brand mark. Adjacent text supplies the accessible name. */
export function BrandLogo({ size = 40, className = "" }: { size?: number; className?: string }) {
  return <img className={`brand-logo ${className}`} src="/brand/mascot.png" width={size} height={size} alt="" aria-hidden="true" draggable={false} style={{ display: "block", flexShrink: 0, objectFit: "contain" }} />;
}
