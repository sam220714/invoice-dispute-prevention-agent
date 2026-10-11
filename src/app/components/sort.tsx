"use client";

import { useMemo, useState } from "react";

export type Dir = "asc" | "desc";

/** Click a header to sort by it, click again to reverse. No sort until the first click. */
export function useSort<T, K extends string>(rows: T[], keys: Record<K, (row: T) => string | number>) {
  const [sort, setSort] = useState<{ key: K; dir: Dir } | null>(null);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const get = keys[sort.key];
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en", { numeric: true });
      return c * sign;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = (key: K) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  return { sorted, sort, toggle };
}

interface SortThProps<K extends string> {
  label: string;
  k: K;
  sort: { key: K; dir: Dir } | null;
  onSort: (k: K) => void;
  right?: boolean;
  className?: string;
}

/** A column header that sorts. The arrow shows the direction once it is the active column. */
export function SortTh<K extends string>({ label, k, sort, onSort, right, className }: SortThProps<K>) {
  const on = sort?.key === k;
  return (
    <th
      className={`${right ? "r " : ""}${className ?? ""}`.trim() || undefined}
      aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button type="button" className={`sort${on ? " on" : ""}`} onClick={() => onSort(k)}>
        {label}
        <span className="arrow" aria-hidden="true">{on ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    </th>
  );
}
