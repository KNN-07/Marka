import { X, Plus } from "lucide-react";
import type { DocumentTab } from "./types";
import { isDirty } from "./types";
export default function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: DocumentTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="tabbar" aria-label="Open documents">
      <div className="tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            className={`tab ${activeId === tab.id ? "active" : ""}`}
            key={tab.id}
          >
            <button
              role="tab"
              aria-selected={activeId === tab.id}
              title={tab.path ?? tab.title}
              onClick={() => onActivate(tab.id)}
            >
              {isDirty(tab) && (
                <span className="dirty-dot" aria-label="Unsaved changes" />
              )}
              {tab.title}
            </button>
            <button
              className="tab-close icon-button"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="icon-button"
        onClick={onNew}
        title="New Markdown (Ctrl/Cmd+N)"
        aria-label="New Markdown"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
