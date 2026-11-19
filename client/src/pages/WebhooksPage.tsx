import { WebhookNotificationsSettings } from '@/components/WebhookNotificationsSettings'

export function WebhooksPage() {
  return <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
    <div>
      <h1 className="text-2xl font-bold text-slate-900">Webhooks</h1>
      <p className="text-sm text-slate-500 mt-1">Manage notification destinations and delivery settings.</p>
    </div>
    <WebhookNotificationsSettings />
  </div>
}
