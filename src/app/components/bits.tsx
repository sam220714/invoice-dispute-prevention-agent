import type { KeyboardEvent, ReactNode } from "react";
import type { Source } from "../../lib/app/presend_view";

export const Id = ({ children }: { children: ReactNode }) => <span className="id">{children}</span>;

/** "DSP-004, 18 Aug · DSP-008, 3 Sept" with the ids in mono. */
export function Sources({ sources }: { sources: Source[] }) {
  return (
    <>
      {sources.map((s, i) => (
        <span key={s.id}>
          {i > 0 && " and "}
          <Id>{s.id}</Id>
          {s.date && `, ${s.date}`}
        </span>
      ))}
    </>
  );
}

/** Enter or Space on a focusable row does what a click does. Buttons inside the row keep their own keys. */
export function activate(fn: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/** The lines a selection touches, as a Set; "ALL" means every line. */
export type Touch = { ids: Set<string>; all: boolean; tone: "ochre" | "teal" } | null;
