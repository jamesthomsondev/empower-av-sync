import { useEffect, useState } from 'react'
import QR from 'qrcode'

/** Renders `value` as a QR code locally (no network → offline-safe). */
export function QRCode({ value, size = 160 }: { value: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    QR.toDataURL(value, { width: size, margin: 1 })
      .then((url) => alive && setDataUrl(url))
      .catch(() => alive && setDataUrl(null))
    return () => {
      alive = false
    }
  }, [value, size])
  if (!dataUrl) return null
  return <img src={dataUrl} width={size} height={size} alt={`QR for ${value}`} />
}
