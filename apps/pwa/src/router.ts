import { useEffect, useState } from 'react';

/**
 * Маршруты в hash (#/calendar, #/clients/<id>): статический хостинг без настройки сервера, кнопка «назад»
 * телефона работает, а офлайн-кэш обслуживает один index.html.
 */
export function useRoute(): string[] {
  const read = () => (window.location.hash.replace(/^#\/?/, '') || 'calendar').split('/');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const update = () => setRoute(read());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function go(path: string): void {
  window.location.hash = `#/${path}`;
}
