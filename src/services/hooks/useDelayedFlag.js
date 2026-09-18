import { useEffect, useState } from 'react';

// A flag that only turns on once `isActive` has been true continuously for
// `delayMs`, and turns off the instant `isActive` does.
//
// Meant for the "Loading…" label at the bottom of a list. A page transition
// or the next page of an infinite scroll usually finishes in well under a
// second, and showing the label immediately meant it flashed on and off
// between one render and the next — noise that read as the wallet stuttering
// rather than as it working. Delaying it means nothing is shown at all for
// the common case, and it only appears when a fetch is genuinely slow enough
// to be worth saying so.
const useDelayedFlag = (isActive, delayMs = 3000) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isActive) {
      setShow(false);
      return undefined;
    }
    const timer = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(timer);
  }, [isActive, delayMs]);

  return show;
};

export default useDelayedFlag;
