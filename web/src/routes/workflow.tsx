// Filing lifecycle, client approval, firm admin, changes-since-last-seen, replay clock. Owned by the workflow feature.
import type { FeatureNavItem, FeatureRoute } from './types';

export const workflowRoutes: FeatureRoute[] = [];
export const workflowNav: FeatureNavItem[] = [];
/** Rendered in the top bar (e.g. replay clock, changes badge). */
export const workflowHeaderWidgets: (() => JSX.Element | null)[] = [];
