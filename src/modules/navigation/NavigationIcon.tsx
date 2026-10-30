import type { ReactNode } from "react";
export function NavigationIcon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    limits: <><path d="M4 19V12M12 19V5M20 19V9" strokeWidth="3" /><path d="M3 22h18" /></>,
    media: <><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="5.5" cy="18" rx="3.5" ry="3" /><ellipse cx="16.5" cy="16" rx="3.5" ry="3" /></>,
    system: <><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9" y="9" width="6" height="6" rx="1" /><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /></>,
    settings: <><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2v3l-2 3h-3l-2 2-3-1-1-3-3-1v-4l2-2V7l2-2Z" /><circle cx="12" cy="11" r="3" /></>,
  };
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.settings}</svg>;
}
