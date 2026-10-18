import {appearanceDefaults,normalizeAppearance,type AppearancePreferences} from '../shared/appearance.ts';
export const fontSizes = [
  {id: 'small', label: '小', scale: 1.2},
  {id: 'medium', label: '标准', scale: 1.4},
  {id: 'large', label: '大', scale: 1.6},
  {id: 'xlarge', label: '超大', scale: 1.8},
] as const;

export type Mode = 'detail' | 'speed';
export type Preferences = AppearancePreferences & {
  fontSize: typeof fontSizes[number]['id'];
  mode: Mode;
  bankId: string;
  sidebarCollapsed: boolean;
  searchCollapsed: boolean;
  speedPreview: boolean;
};
export const preferenceKey = 'question-bank.appearance.v3';
export const defaults: Preferences = {...appearanceDefaults,fontSize: 'medium', mode: 'detail', bankId: '', sidebarCollapsed: false, searchCollapsed: false, speedPreview: false};

export function loadPreferences(): Preferences {
  try {
    const saved=localStorage.getItem(preferenceKey)||localStorage.getItem('question-bank.appearance.v2');
    const value = JSON.parse(saved || localStorage.getItem('question-bank.appearance.v1') || '{}');
    // The old largest size becomes the new standard without enlarging it twice.
    if(!saved&&value.fontSize==='xlarge')value.fontSize='medium';
    return {
      ...normalizeAppearance(value),
      fontSize: fontSizes.some(f => f.id === value.fontSize) ? value.fontSize : defaults.fontSize,
      mode: value.mode === 'speed' ? 'speed' : 'detail',
      bankId: typeof value.bankId === 'string' ? value.bankId : '',
      sidebarCollapsed: value.sidebarCollapsed === true,
      searchCollapsed: value.searchCollapsed === true,
      speedPreview: value.speedPreview === true,
    };
  } catch { return {...defaults}; }
}
