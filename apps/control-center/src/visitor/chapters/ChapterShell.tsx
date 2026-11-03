import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import './chapters.css';

/** Which chapter to open after the visitor chose this story, and whether to bring it into view. */
export interface Opened {
  readonly chapter: number;
  readonly scroll: boolean;
}

/** The chapter on screen; `go` moves focus to its heading so keyboard and screen-reader users follow. */
export function useChapters(opened?: Opened | null) {
  const [chapter, setChapter] = useState(0);
  // Each move asks for focus once the new chapter is on screen, even when the chapter is unchanged.
  const [focus, setFocus] = useState<{ readonly n: number; readonly scroll: boolean } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const go = useCallback((index: number, scroll = true) => {
    setChapter(index);
    setFocus((previous) => ({ n: (previous?.n ?? 0) + 1, scroll }));
  }, []);
  useEffect(() => {
    if (focus) heading.current?.focus({ preventScroll: !focus.scroll });
  }, [focus]);
  useEffect(() => {
    if (opened) go(opened.chapter, opened.scroll);
  }, [opened, go]);
  return { chapter, go, heading };
}

/** A story's chapters as stations on one line, the chapter itself, and previous/next. */
export function ChapterShell({
  label,
  className,
  navLabel,
  chapters,
  chapter,
  go,
  heading,
  facts,
  back,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly navLabel: string;
  readonly chapters: readonly string[];
  readonly chapter: number;
  readonly go: (index: number) => void;
  readonly heading: RefObject<HTMLHeadingElement | null>;
  readonly facts?: ReactNode;
  /** The last chapter's button returns to the first. */
  readonly back: string;
  readonly children: ReactNode;
}) {
  const last = chapters.length - 1;
  return (
    <section
      className={className ? `visitor-workspace ${className}` : 'visitor-workspace'}
      aria-label={label}
    >
      <div className="chapter-nav">
        <nav
          aria-label={navLabel}
          style={{ '--n': chapters.length, '--at': chapter } as CSSProperties}
        >
          {chapters.map((name, index) => (
            <button
              type="button"
              key={name}
              aria-current={chapter === index ? 'step' : undefined}
              onClick={() => go(index)}
            >
              {name}
            </button>
          ))}
        </nav>
        {facts && <div className="run-facts">{facts}</div>}
      </div>
      <div className="chapter-content" id="chapter">
        <h2 ref={heading} tabIndex={-1}>
          {chapters[chapter]}
        </h2>
        <div className="chapter-body" key={`body-${chapter}`}>
          {children}
        </div>
        <div className="chapter-footer">
          <button
            type="button"
            className="visitor-button quiet"
            disabled={chapter === 0}
            onClick={() => go(chapter - 1)}
          >
            Previous
          </button>
          <span>{chapters[chapter]}</span>
          <button
            type="button"
            className="visitor-button"
            onClick={() => go(chapter === last ? 0 : chapter + 1)}
          >
            {chapter === last ? back : 'Next chapter'}
          </button>
        </div>
      </div>
    </section>
  );
}
