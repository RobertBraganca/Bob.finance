import { useEffect, useId, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { supabase } from '../../lib/supabaseClient'
import { Button, Card, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { formatDocument, type IssuerSettings } from './types'

const BUCKET = 'proposal-assets'
const MAX_LOGO_BYTES = 1024 * 1024

/**
 * Parâmetros › Dados do orçamento (decisions/0040): o cabeçalho do PDF que
 * vai ao cliente. A logo fica num bucket privado do Storage, com acesso só da
 * conta admin; a prévia e o PDF usam um link assinado de curta duração.
 */
export function IssuerCard() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const ids = { name: useId(), document: useId(), email: useId(), phone: useId(), validity: useId() }

  const issuer = useQuery({
    queryKey: ['proposals', 'issuer'],
    queryFn: () => api.get<IssuerSettings>('/pricing/proposal-issuer'),
  })
  const [form, setForm] = useState<Record<'businessName' | 'document' | 'email' | 'phone' | 'validity', string> | null>(null)
  useEffect(() => {
    if (issuer.data && form === null) {
      setForm({
        businessName: issuer.data.businessName ?? '',
        document: formatDocument(issuer.data.document),
        email: issuer.data.email ?? '',
        phone: issuer.data.phone ?? '',
        validity: String(issuer.data.defaultValidityDays),
      })
    }
  }, [issuer.data, form])

  const logoPath = issuer.data?.logoPath ?? null
  const preview = useQuery({
    queryKey: ['proposals', 'issuer-logo', logoPath],
    queryFn: async () => {
      const signed = await supabase.storage.from(BUCKET).createSignedUrl(logoPath!, 600)
      if (signed.error) throw signed.error
      return signed.data.signedUrl
    },
    enabled: !!logoPath,
    staleTime: 5 * 60_000,
  })

  const save = useMutation({
    mutationFn: (patch: Partial<IssuerSettings>) => api.put<IssuerSettings>('/pricing/proposal-issuer', patch),
    onSuccess: (data) => queryClient.setQueryData(['proposals', 'issuer'], data),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('A logo precisa ser PNG ou JPG.')
      if (file.size > MAX_LOGO_BYTES) throw new Error('A logo precisa ter até 1 MB.')
      const path = `logo-${Date.now()}.${file.type === 'image/png' ? 'png' : 'jpg'}`
      const result = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type, upsert: false })
      if (result.error) throw new Error(`não foi possível enviar a logo: ${result.error.message}`)
      const saved = await api.put<IssuerSettings>('/pricing/proposal-issuer', { logoPath: path })
      // A anterior sai do bucket depois que a nova já está gravada.
      if (logoPath) await supabase.storage.from(BUCKET).remove([logoPath])
      return saved
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['proposals', 'issuer'], data)
      toast('Logo atualizada')
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao enviar a logo', 'error'),
  })

  const removeLogo = useMutation({
    mutationFn: async () => {
      const saved = await api.put<IssuerSettings>('/pricing/proposal-issuer', { logoPath: null })
      if (logoPath) await supabase.storage.from(BUCKET).remove([logoPath])
      return saved
    },
    onSuccess: (data) => queryClient.setQueryData(['proposals', 'issuer'], data),
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao remover a logo', 'error'),
  })

  const submit = () => {
    if (!form) return
    save.mutate(
      {
        businessName: form.businessName,
        document: form.document,
        email: form.email,
        phone: form.phone,
        defaultValidityDays: Math.max(1, Math.min(365, Math.floor(Number(form.validity) || 15))),
      },
      { onSuccess: () => toast('Dados do orçamento salvos') },
    )
  }

  return (
    <Card span={12} title="Dados do orçamento" subtitle="O cabeçalho do PDF que vai ao cliente: quem está emitindo e por quanto tempo vale">
      {!form ? (
        <SkeletonLines lines={4} />
      ) : (
        <div className="stack">
          <div className="row row--wrap" style={{ gap: 'var(--sp-4)', alignItems: 'center' }}>
            <div
              style={{
                width: 120,
                height: 64,
                borderRadius: 'var(--r-sm)',
                border: '1px dashed var(--line-strong)',
                display: 'grid',
                placeItems: 'center',
                background: 'var(--surface-muted)',
                overflow: 'hidden',
              }}
            >
              {preview.data ? (
                <img src={preview.data} alt="Logo atual" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
              ) : (
                <span className="muted" style={{ fontSize: 'var(--text-xs)' }}>
                  sem logo
                </span>
              )}
            </div>
            <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) upload.mutate(file)
                  event.target.value = ''
                }}
              />
              <Button size="sm" icon="image" onClick={() => fileRef.current?.click()} loading={upload.isPending}>
                {logoPath ? 'Trocar logo' : 'Enviar logo'}
              </Button>
              {logoPath && (
                <Button variant="quiet" size="sm" onClick={() => removeLogo.mutate()} loading={removeLogo.isPending}>
                  Remover
                </Button>
              )}
              <span className="field__hint" style={{ width: '100%' }}>
                PNG ou JPG, até 1 MB. Fundo transparente fica melhor no PDF.
              </span>
            </div>
          </div>
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <label className="field__label" htmlFor={ids.name}>
                Nome comercial
              </label>
              <TextInput id={ids.name} value={form.businessName} onChange={(businessName) => setForm({ ...form, businessName })} placeholder="ex. BEEKOFF Design" />
            </div>
            <div className="field" style={{ flex: '1 1 180px' }}>
              <label className="field__label" htmlFor={ids.document}>
                CPF ou CNPJ
              </label>
              <TextInput id={ids.document} value={form.document} onChange={(document) => setForm({ ...form, document })} placeholder="00.000.000/0000-00" />
            </div>
          </div>
          <div className="row row--wrap" style={{ gap: 'var(--sp-3)' }}>
            <div className="field" style={{ flex: '2 1 240px' }}>
              <label className="field__label" htmlFor={ids.email}>
                E-mail
              </label>
              <TextInput id={ids.email} value={form.email} onChange={(email) => setForm({ ...form, email })} type="email" placeholder="contato@empresa.com" />
            </div>
            <div className="field" style={{ flex: '1 1 160px' }}>
              <label className="field__label" htmlFor={ids.phone}>
                Telefone
              </label>
              <TextInput id={ids.phone} value={form.phone} onChange={(phone) => setForm({ ...form, phone })} type="tel" placeholder="(27) 99999-0000" />
            </div>
            <div className="field" style={{ flex: '1 1 140px' }}>
              <label className="field__label" htmlFor={ids.validity}>
                Validade padrão (dias)
              </label>
              <TextInput id={ids.validity} value={form.validity} onChange={(validity) => setForm({ ...form, validity })} numeral />
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <Button variant="primary" icon="check" onClick={submit} loading={save.isPending}>
              Salvar dados
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
