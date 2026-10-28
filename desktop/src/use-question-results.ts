import {useCallback, useLayoutEffect, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {Hit, Results} from './types';

type Search = {text: string; bank_id: string; kind: string};
type Session = {search: Search; items: Hit[]; after: number; more: boolean; pending: boolean};

export function useQuestionResults(search: Search, revision: number, onResults: (result: Results, initial: boolean) => void) {
  const [state, setState] = useState({items: [] as Hit[], more: true, loading: true, error: ''});
  const session = useRef<Session | null>(null);
  const callback = useRef(onResults);
  callback.current = onResults;
  const loadMore = useCallback(async () => {
    const current = session.current;
    if (!current || current.pending || !current.more) return;
    current.pending = true;
    setState(previous => ({...previous, loading: true, error: ''}));
    try {
      const result = await invoke<Results>('search', {query: {...current.search, after_rowid: current.after}});
      if (session.current !== current) return;
      const initial = current.after === 0;
      current.items = current.items.concat(result.items);
      current.after = result.items.at(-1)?.rowid ?? current.after;
      current.more = result.has_more && result.items.length > 0;
      setState({items: current.items, more: current.more, loading: false, error: ''});
      callback.current({...result, items: current.items, has_more: current.more}, initial);
    } catch (error) {
      if (session.current === current) setState(previous => ({...previous, loading: false, error: String(error)}));
    } finally {
      current.pending = false;
    }
  }, []);

  useLayoutEffect(() => {
    const current: Session = {search, items: [], after: 0, more: true, pending: false};
    session.current = current;
    setState({items: [], more: true, loading: true, error: ''});
    void loadMore();
    return () => { if (session.current === current) session.current = null; };
  }, [search.text, search.bank_id, search.kind, revision, loadMore]);

  return {...state, loadMore};
}
