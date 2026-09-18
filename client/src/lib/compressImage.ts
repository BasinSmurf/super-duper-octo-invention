/**
 * Compress an image file by resizing and re-encoding as JPEG.
 * Returns a base64 data URL.
 *
 * @param file - The image File from input
 * @param maxWidth - Maximum dimension (width or height), default 1920
 * @param quality - JPEG quality 0-1, default 0.7
 * @returns Promise resolving to a base64 data URL string
 */
export function compressImage(
  file: File,
  maxWidth = 1920,
  quality = 0.7,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      let { width, height } = img

      // Scale down if larger than maxWidth (preserving aspect ratio)
      if (width > maxWidth || height > maxWidth) {
        if (width > height) {
          height = Math.round((height * maxWidth) / width)
          width = maxWidth
        } else {
          width = Math.round((width * maxWidth) / height)
          height = maxWidth
        }
      }

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Failed to get canvas context'))
        return
      }

      ctx.drawImage(img, 0, 0, width, height)

      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      resolve(dataUrl)
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load image'))
    }

    img.src = url
  })
}

/**
 * Estimate the byte size of a base64 data URL.
 */
export function estimateBase64Size(dataUrl: string): number {
  // Remove the data:...;base64, prefix
  const base64 = dataUrl.split(',')[1] || ''
  // Base64 encodes 3 bytes into 4 chars
  return Math.round((base64.length * 3) / 4)
}

/**
 * Format bytes into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
