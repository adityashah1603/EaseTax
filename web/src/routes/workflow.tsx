// Filing lifecycle, client approval, firm admin, changes-since-last-seen, replay clock, judgments. Owned by the workflow feature.
import { Bell, Building2, Clock, Gavel, Send } from 'lucide-react';
import { ChangesBadge, ReplayClock } from '../components/workflow/HeaderWidgets';
import { Changes } from '../pages/workflow/Changes';
import { Filing } from '../pages/workflow/Filing';
import { Firm } from '../pages/workflow/Firm';
import { Judgments } from '../pages/workflow/Judgments';
import { Replay } from '../pages/workflow/Replay';
import type { FeatureNavItem, FeatureRoute } from './types';

export const workflowRoutes: FeatureRoute[] = [
  { path: '/filing', element: <Filing /> },
  { path: '/firm', element: <Firm /> },
  { path: '/changes', element: <Changes /> },
  { path: '/replay', element: <Replay /> },
  { path: '/judgments', element: <Judgments /> },
];

export const workflowNav: FeatureNavItem[] = [
  { to: '/judgments', icon: <Gavel size={15} />, text: 'Judgments', order: 75 },
  { to: '/changes', icon: <Bell size={15} />, text: 'Since I last looked', order: 80 },
  { to: '/filing', icon: <Send size={15} />, text: 'Filing', order: 85 },
  { to: '/replay', icon: <Clock size={15} />, text: 'Season replay', order: 90 },
  { to: '/firm', icon: <Building2 size={15} />, text: 'Firm', order: 95 },
];

/** Rendered in the top bar (e.g. replay clock, changes badge). */
export const workflowHeaderWidgets: (() => JSX.Element | null)[] = [ReplayClock, ChangesBadge];
