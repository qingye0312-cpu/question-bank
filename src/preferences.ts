export const fontSizes = [
  {id: 'small', label: '小', scale: 1.2},
  {id: 'medium', label: '标准', scale: 1.4},
  {id: 'large', label: '大', scale: 1.6},
  {id: 'xlarge', label: '超大', scale: 1.8},
] as const;

export const themes = [
  {id: 'forest', label: '松绿', color: '#236752'},
  {id: 'ocean', label: '海蓝', color: '#285fa1'},
  {id: 'violet', label: '紫藤', color: '#7354a0'},
  {id: 'amber', label: '暖杏', color: '#955e24'},
  {id: 'slate', label: '石墨', color: '#526073'},
  {id: 'night', label: '深色', color: '#203132'},
] as const;

export type Mode = 'detail' | 'speed';
export type Preferences = {
  fontSize: typeof fontSizes[number]['id'];
  theme: typeof themes[number]['id'];
  mode: Mode;
  bankId: string;
  sidebarCollapsed: boolean;
  searchCollapsed: boolean;
  speedPreview: boolean;
};
export const preferenceKey = 'question-bank.appearance.v2';
export const defaults: Preferences = {fontSize: 'medium', theme: 'forest', mode: 'detail', bankId: '', sidebarCollapsed: false, searchCollapsed: false, speedPreview: false};

export function loadPreferences(): Preferences {
  try {
    const saved=localStorage.getItem(preferenceKey);
    const value = JSON.parse(saved || localStorage.getItem('question-bank.appearance.v1') || '{}');
    // The old largest size becomes the new standard without enlarging it twice.
    if(!saved&&value.fontSize==='xlarge')value.fontSize='medium';
    return {
      fontSize: fontSizes.some(f => f.id === value.fontSize) ? value.fontSize : defaults.fontSize,
      theme: themes.some(t => t.id === value.theme) ? value.theme : defaults.theme,
      mode: value.mode === 'speed' ? 'speed' : 'detail',
      bankId: typeof value.bankId === 'string' ? value.bankId : '',
      sidebarCollapsed: value.sidebarCollapsed === true,
      searchCollapsed: value.searchCollapsed === true,
      speedPreview: value.speedPreview === true,
    };
  } catch { return {...defaults}; }
}
