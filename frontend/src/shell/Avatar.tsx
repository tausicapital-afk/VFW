/**
 * A person, at whatever size the surface needs.
 *
 * Two renderings, and the initials one is not a fallback: most accounts have no
 * upload and are never expected to get one, so "coloured circle with initials"
 * is the normal way this component draws someone. That framing matters — it is
 * why nothing here reserves space for a spinner or shows a broken-image glyph,
 * and why object storage being unconfigured costs the UI nothing at all.
 */
export function initialsOf(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function Avatar({
  name,
  colour,
  src,
  size = 34,
  className = 'av',
}: {
  name: string;
  colour?: string | null;
  src?: string | null;
  /** Diameter in px. Type scales with it so initials never overflow the circle. */
  size?: number;
  className?: string;
}) {
  const style: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flex: '0 0 auto',
    display: 'grid',
    placeItems: 'center',
    fontFamily: 'Archivo',
    fontWeight: 700,
    fontSize: Math.max(10, Math.round(size * 0.36)),
    color: '#fff',
    background: colour ?? '#0E0E11',
    overflow: 'hidden',
  };

  if (src) {
    return (
      <img
        className={className}
        // The alt text is the name rather than "avatar": to a screen reader the
        // picture *is* the person, and "avatar of Ann Lee" would be read out
        // beside the name it sits next to every time.
        alt={name}
        src={src}
        style={{ ...style, objectFit: 'cover' }}
      />
    );
  }

  return (
    <div className={className} style={style} aria-hidden>
      {initialsOf(name)}
    </div>
  );
}
