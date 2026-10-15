// CPA records (views), version compare and what-ifs. Owned by the views feature.
import { BookOpen, FlaskConical, GitCompare } from 'lucide-react';
import { Compare } from '../pages/records/Compare';
import { RecordView } from '../pages/records/RecordView';
import { RecordsIndex } from '../pages/records/RecordsIndex';
import { WhatIfs } from '../pages/records/WhatIfs';
import type { FeatureNavItem, FeatureRoute } from './types';

export const viewRoutes: FeatureRoute[] = [
  { path: '/records', element: <RecordsIndex /> },
  { path: '/records/:viewId', element: <RecordView /> },
  { path: '/compare', element: <Compare /> },
  { path: '/what-ifs', element: <WhatIfs /> },
];

export const viewNav: FeatureNavItem[] = [
  { to: '/records', icon: <BookOpen size={15} />, text: 'Records', order: 50 },
  { to: '/compare', icon: <GitCompare size={15} />, text: 'Compare versions', order: 60 },
  { to: '/what-ifs', icon: <FlaskConical size={15} />, text: 'What-ifs', order: 70 },
];
