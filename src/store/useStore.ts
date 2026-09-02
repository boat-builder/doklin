// React binding for a datastore: hold the shared model for `dir` while the
// component is mounted, and re-render on every change the model publishes
// (a local mutation, or the folder watcher's rescan after someone else's).

import { useEffect, useState } from "react";
import { acquireStore, releaseStore, type StoreModel, type StoreState } from "./model";

const idleState = (dir: string): StoreState => ({
  dir,
  def: null,
  cards: [],
  conflicts: [],
  truncated: false,
  loading: dir !== "",
  error: null,
});

/**
 * `dir` of "" (or null) means "nothing to show" — the hook then holds no
 * model and starts no watcher, so a note that isn't in a store costs nothing.
 */
export function useStore(dir: string | null): {
  state: StoreState;
  model: StoreModel | null;
} {
  const [state, setState] = useState<StoreState>(() => idleState(dir ?? ""));
  // State, not a ref: a ref set inside the effect wouldn't force the render
  // that hands the model to the view, and a board whose `model` is null
  // silently swallows every mutation.
  const [model, setModel] = useState<StoreModel | null>(null);

  useEffect(() => {
    if (!dir) {
      setModel(null);
      setState(idleState(""));
      return;
    }
    const held = acquireStore(dir);
    setModel(held);
    setState(held.snapshot);
    const un = held.subscribe(setState);
    return () => {
      un();
      setModel(null);
      releaseStore(dir);
    };
  }, [dir]);

  return { state, model };
}
