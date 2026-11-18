import { photoGps } from '@/lib/photoGps'
import { useState, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { Camera, X, Loader2 } from 'lucide-react'
import { compressImage, estimateBase64Size, formatBytes } from '@/lib/compressImage'

export interface CapturedPhoto {
  id: string
  dataUrl: string
  timestamp: string
  latitude?: number | null
  longitude?: number | null
  accuracy?: number | null
  geotaggedAt?: string | null
}

interface PhotoCaptureProps {
  photos: CapturedPhoto[]
  onChange: (photos: CapturedPhoto[]) => void
  maxPhotos?: number
  captureLocation?: boolean
}

export function PhotoCapture({ photos, onChange, maxPhotos = 10, captureLocation = false }: PhotoCaptureProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [compressing, setCompressing] = useState(false)

  async function handleCapture(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files) return

    setCompressing(true)
    const newPhotos: CapturedPhoto[] = []
    let devicePosition: ReturnType<typeof currentPosition> | undefined

    for (const file of Array.from(files)) {
      if (photos.length + newPhotos.length >= maxPhotos) break

      const embeddedGps = captureLocation ? photoGps(await file.arrayBuffer()) : null
      const position = embeddedGps
        ? { ...embeddedGps, geotaggedAt: new Date().toISOString() }
        : captureLocation ? await (devicePosition ??= currentPosition()).catch(() => null) : null
      try {
        const dataUrl = await compressImage(file, 1920, 0.7)
        newPhotos.push({
          id: uuidv4(),
          dataUrl,
          timestamp: new Date().toISOString(),
          ...(position ?? {}),
        })
      } catch {
        // Fallback to raw FileReader if compression fails
        const dataUrl = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = (ev) => resolve(ev.target?.result as string)
          reader.readAsDataURL(file)
        })
        newPhotos.push({
          id: uuidv4(),
          dataUrl,
          timestamp: new Date().toISOString(),
          ...(position ?? {}),
        })
      }
    }

    onChange([...photos, ...newPhotos])
    setCompressing(false)

    // Reset input so same file can be selected again
    e.target.value = ''
  }

  function removePhoto(id: string) {
    onChange(photos.filter(p => p.id !== id))
    if (previewing === id) setPreviewing(null)
  }

  // Calculate total storage used
  const totalBytes = photos.reduce((sum, p) => sum + estimateBase64Size(p.dataUrl), 0)

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={handleCapture}
        className="hidden"
      />

      {/* Photo grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {photos.map(photo => (
          <div key={photo.id} className="relative aspect-square rounded-lg overflow-hidden bg-slate-100 group">
            <img
              src={photo.dataUrl}
              alt="Captured"
              className="w-full h-full object-cover cursor-pointer"
              onClick={() => setPreviewing(photo.id)}
            />
            <button
              type="button"
              onClick={() => removePhoto(photo.id)}
              className="absolute top-1 right-1 w-6 h-6 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-3 h-3 text-white" />
            </button>
          </div>
        ))}

        {/* Add photo button */}
        {photos.length < maxPhotos && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={compressing}
            className="aspect-square rounded-lg border-2 border-dashed border-slate-300 flex flex-col items-center justify-center gap-1 text-slate-400 hover:text-slate-600 hover:border-slate-400 transition-colors disabled:opacity-50"
          >
            {compressing ? (
              <Loader2 className="w-6 h-6 animate-spin" />
            ) : (
              <Camera className="w-6 h-6" />
            )}
            <span className="text-xs font-medium">
              {compressing ? 'Compressing...' : photos.length === 0 ? 'Add Photo' : 'More'}
            </span>
          </button>
        )}
      </div>

      {photos.length > 0 && (
        <p className="text-xs text-slate-400 mt-2">
          {photos.length} of {maxPhotos} photos ({formatBytes(totalBytes)})
          {captureLocation && photos.some(p => p.latitude != null && p.longitude != null) && (
            <span className="text-emerald-600"> · GPS tagged</span>
          )}
        </p>
      )}

      {captureLocation && photos.some(photo => photo.latitude == null || photo.longitude == null) && <p role="alert" className="mt-2 text-sm text-red-700">This photo has no GPS. Choose a GPS-tagged original, or allow device location and capture it again before continuing.</p>}
      {/* Full-screen preview */}
      {previewing && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setPreviewing(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 w-10 h-10 bg-white/20 rounded-full flex items-center justify-center"
            onClick={() => setPreviewing(null)}
          >
            <X className="w-6 h-6 text-white" />
          </button>
          <img
            src={photos.find(p => p.id === previewing)?.dataUrl}
            alt="Preview"
            className="max-w-full max-h-full object-contain rounded-lg"
          />
        </div>
      )}
    </div>
  )
}

function currentPosition(): Promise<Pick<CapturedPhoto, 'latitude' | 'longitude' | 'accuracy' | 'geotaggedAt'>> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        geotaggedAt: new Date().toISOString(),
      }),
      reject,
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    )
  })
}
