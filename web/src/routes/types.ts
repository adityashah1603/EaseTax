// Extension points so feature modules add pages and nav items without editing App/Shell.
import type { ReactNode } from 'react';

export interface FeatureRoute {
  path: string;
  element: ReactNode;
}

export interface FeatureNavItem {
  to: string;
  icon: ReactNode;
  text: string;
  /** Lower sorts first; core items use 0–40. */
  order: number;
}
