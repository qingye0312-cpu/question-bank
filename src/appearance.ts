import {resolveAppearance,themeTokens,type AppearancePreferences,type ColorScheme} from '../shared/appearance.ts';

export function systemScheme():ColorScheme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function watchSystemScheme(update:(scheme:ColorScheme)=>void):()=>void {
  const media=window.matchMedia?.('(prefers-color-scheme: dark)');
  if(!media)return ()=>{};
  const change=()=>update(media.matches ? 'dark' : 'light');
  change();
  if(media.addEventListener){media.addEventListener('change',change);return()=>media.removeEventListener('change',change);}
  media.addListener(change);return()=>media.removeListener(change);
}
export function applyAppearance(preferences:AppearancePreferences, system:ColorScheme,preview:ColorScheme|null=null):void {
  const {theme,scheme}=resolveAppearance(preferences,system,preview),root=document.documentElement;
  root.dataset.theme=theme;root.dataset.colorScheme=scheme;root.dataset.themeMode=preferences.themeMode;
  root.style.colorScheme=scheme;
  for(const [key,value] of Object.entries(themeTokens(theme,scheme)))root.style.setProperty(`--${key}`,value);
}
