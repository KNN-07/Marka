export type Heading = { id: string; text: string; depth: number; from: number };
export default function OutlinePanel({
  headings,
  onSelect,
}: {
  headings: Heading[];
  onSelect: (from: number) => void;
}) {
  return (
    <aside className="outline">
      <h2>On this page</h2>
      <nav aria-label="Document outline">
        {headings.length ? (
          headings.map((heading) => (
            <button
              key={heading.id}
              style={{ paddingLeft: 12 + (heading.depth - 1) * 10 }}
              onClick={() => onSelect(heading.from)}
            >
              {heading.text}
            </button>
          ))
        ) : (
          <p className="muted small">Headings will appear here.</p>
        )}
      </nav>
    </aside>
  );
}
