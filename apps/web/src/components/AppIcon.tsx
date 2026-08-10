interface AppIconProps {
  name: 'home' | 'score' | 'board' | 'more' | 'sync' | 'flag';
}

export function AppIcon({ name }: AppIconProps) {
  const paths = {
    home: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9.5 20v-6h5v6"/></>,
    score: <><path d="M6 3h12v18H6z"/><path d="M9 7h6M9 11h6M9 15h2"/><path d="m14.5 15 1.5 1.5 3-3"/></>,
    board: <><path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
    sync: <><path d="M20 7h-5V2"/><path d="M20 7a8 8 0 0 0-14.5-2M4 17h5v5"/><path d="M4 17a8 8 0 0 0 14.5 2"/></>,
    flag: <><path d="M5 21V3"/><path d="M5 4h11l-2 4 2 4H5"/></>,
  };
  return (
    <svg className="app-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}
