import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth } from '@/contexts/AuthContext'
import {
  ArrowLeft,
  MapPin,
  Layers,
  ChevronRight,
  Loader2,
  Droplets,
  Wrench,
} from 'lucide-react'

// ---- Types ----
interface PadInField {
  id: string
  name: string
  isActive: boolean
  _count: { wells: number }
}

interface FacilityInField {
  id: string
  name: string
  facilityType: string
  isActive: boolean
}

interface FieldDetail {
  id: string
  name: string
  county: string | null
  state: string
  notes: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  pads: PadInField[]
  facilities: FacilityInField[]
}

function formatDate(d: string | null): string {
  if (!d) return '---'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function FieldDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const [field, setField] = useState<FieldDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Field is a DMR reference data point, kept for admin reference only — the
  // rest of the app hides it (too much "unassigned" confusion for ops).
  const isAdmin = user?.role === 'platform_admin'

  useEffect(() => {
    if (!id || !isAdmin) return
    setLoading(true)
    setError(null)
    api.get<FieldDetail>(`/locations/fields/${id}`)
      .then(data => setField(data))
      .catch(e => setError(e.message || 'Failed to load field'))
      .finally(() => setLoading(false))
  }, [id, isAdmin])

  if (!isAdmin) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button onClick={() => navigate('/locations')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Locations
        </button>
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg text-sm">
          Field is kept for reference only and isn't part of day-to-day location management. Platform admin access required.
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
        <span className="ml-2 text-gray-500">Loading field...</span>
      </div>
    )
  }

  if (error || !field) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6">
        <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
          {error || 'Field not found'}
        </div>
      </div>
    )
  }

  const totalWells = field.pads.reduce((s, p) => s + p._count.wells, 0)

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div>
        <button onClick={() => navigate('/locations')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Locations
        </button>
        <div className="flex items-start gap-3">
          <div className="w-12 h-12 rounded-xl bg-emerald-50 flex items-center justify-center flex-shrink-0">
            <MapPin className="w-6 h-6 text-emerald-600" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">{field.name}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {field.county && `${field.county} County, `}{field.state}
              {' '}— {field.pads.length} pads, {totalWells} wells
            </p>
            {!field.isActive && (
              <span className="text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full mt-1 inline-block">Inactive</span>
            )}
          </div>
        </div>
        {field.notes && (
          <div className="mt-3 p-2 bg-gray-50 rounded text-sm text-gray-600">
            {field.notes}
          </div>
        )}
      </div>

      {/* Pads Card */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="px-4 py-3 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
            <Layers className="w-4 h-4" /> Pads
            <span className="text-xs text-gray-400 font-normal">({field.pads.length})</span>
          </h2>
        </div>
        <div className="divide-y divide-gray-100">
          {field.pads.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-400 text-center italic">No active pads in this field.</p>
          ) : (
            field.pads.map(pad => (
              <button
                key={pad.id}
                onClick={() => navigate(`/locations/pads/${pad.id}`)}
                className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors"
              >
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <Layers className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-800 truncate">{pad.name}</span>
                </div>
                <div className="flex items-center gap-1 text-xs text-gray-400 flex-shrink-0">
                  <Droplets className="w-3 h-3" /> {pad._count.wells} wells
                </div>
                <ChevronRight className="w-4 h-4 text-gray-300 flex-shrink-0" />
              </button>
            ))
          )}
        </div>
      </div>

      {/* Facilities Card */}
      {field.facilities.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
          <div className="px-4 py-3 border-b border-gray-100">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <Wrench className="w-4 h-4" /> Facilities
              <span className="text-xs text-gray-400 font-normal">({field.facilities.length})</span>
            </h2>
          </div>
          <div className="divide-y divide-gray-100">
            {field.facilities.map(f => (
              <div key={f.id} className="px-4 py-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                  <Wrench className="w-4 h-4 text-purple-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-800">{f.name}</span>
                  <span className="ml-2 text-xs text-gray-400">{f.facilityType}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="text-xs text-gray-400 text-center pb-4">
        Created {formatDate(field.createdAt)} &middot; Last updated {formatDate(field.updatedAt)}
      </div>
    </div>
  )
}
