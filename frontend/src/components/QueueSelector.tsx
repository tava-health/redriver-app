import { useState, useRef, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type QueueOption = { name: string; url: string };

type Props = {
  options: QueueOption[];
  value: QueueOption | null;
  onChange: (queue: QueueOption | null) => void;
  placeholder?: string;
  disabled?: boolean;
  label: string;
};

export function QueueSelector({
  options,
  value,
  onChange,
  placeholder = "Type to search…",
  disabled,
  label,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const displayValue = value?.name ?? "";
  const search = filter.trim().toLowerCase();
  const filtered =
    search === ""
      ? options
      : options.filter((q) => q.name.toLowerCase().includes(search));

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  return (
    <div className="space-y-2" ref={containerRef}>
      <label className="text-sm font-medium text-foreground">{label}</label>
      <div className="relative">
        <Input
          type="text"
          placeholder={placeholder}
          disabled={disabled}
          value={open ? filter : displayValue}
          onChange={(e) => {
            setFilter(e.target.value);
            if (!open) setOpen(true);
            if (!e.target.value) onChange(null);
          }}
          onFocus={() => {
            setOpen(true);
            setFilter(value?.name ?? "");
          }}
          className={cn(open && "rounded-b-none border-b-0")}
        />
        {open && (
          <ul
            className="absolute z-10 w-full max-h-60 overflow-auto rounded-b-md border border-t-0 border-border bg-card py-1 shadow-md"
            role="listbox"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No queues match</li>
            ) : (
              filtered.map((q) => (
                <li
                  key={q.url}
                  role="option"
                  aria-selected={value?.url === q.url}
                  className={cn(
                    "cursor-pointer px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground",
                    value?.url === q.url && "bg-accent text-accent-foreground"
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(q);
                    setFilter("");
                    setOpen(false);
                  }}
                >
                  {q.name}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
