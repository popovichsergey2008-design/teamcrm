import { useEffect, useRef } from 'react';

/**
 * Видео- и звуковые элементы созвона.
 *
 * Вынесены отдельно, потому что нужны и полному окну, и свёрнутому: дорожку
 * нельзя задать разметкой, только из кода и только после появления элемента —
 * повторять этот эффект в двух местах значит однажды забыть его в одном.
 */

/** Своё видео обязательно без звука, иначе слышишь сам себя. */
export function RemoteMedia({ track, muted = false }: { track: MediaStreamTrack; muted?: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

export function RemoteAudio({ track }: { track: MediaStreamTrack }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = new MediaStream([track]);
  }, [track]);
  return <audio ref={ref} autoPlay />;
}
