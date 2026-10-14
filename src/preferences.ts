export const fontSizes = [
  {id: 'small', label: '小', scale: .9},
  {id: 'medium', label: '中', scale: 1},
  {id: 'large', label: '大', scale: 1.2},
  {id: 'xlarge', label: '超大', scale: 1.4},
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
};
export const preferenceKey = 'question-bank.appearance.v1';
export const defaults: Preferences = {fontSize: 'medium', theme: 'forest', mode: 'detail', bankId: '', sidebarCollapsed: false, searchCollapsed: false};

export function loadPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) || '{}');
    return {
      fontSize: fontSizes.some(f => f.id === value.fontSize) ? value.fontSize : defaults.fontSize,
      theme: themes.some(t => t.id === value.theme) ? value.theme : defaults.theme,
      mode: value.mode === 'speed' ? 'speed' : 'detail',
      bankId: typeof value.bankId === 'string' ? value.bankId : '',
      sidebarCollapsed: value.sidebarCollapsed === true,
      searchCollapsed: value.searchCollapsed === true,
    };
  } catch { return {...defaults}; }
}
