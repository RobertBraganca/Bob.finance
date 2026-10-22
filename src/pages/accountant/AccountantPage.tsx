import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { currentPeriod, shiftPeriod } from '../../lib/period'
import { periodLong } from '../../lib/format'
import { supabase } from '../../lib/supabaseClient'
import { PageHeader } from '../../components/shell/Shell'
import { Button, Card, ConfirmDeleteModal, Field, LoadError, PeriodNav, SkeletonLines, TextInput, useToast } from '../../components/ui'
import { AccountantMonthView, PackagesList } from './AccountantMonthView'
import { PACKAGE_BUCKET, SHARE_DAYS, transactionsCsv, type AccessUser, type AccountantMonth, type AccountantPackage } from './types'

type Generated = { pdfUrl: string; csvUrl: string; expiresOn: string; message: string }

/**
 * Contador (docs/specs/tarefas-comercial-contador, fases 4 e 5), na visão do dono:
 * a prévia do que o contador vê do mês, o pacote do mês (PDF e CSV) por link com
 * validade, e quem tem acesso próprio, só leitura e só da parte da empresa.
 */
export function AccountantPage() {
  const toast = useToast()
  const queryClient = useQueryClient()
  const [period, setPeriod] = useState(() => shiftPeriod(currentPeriod(), -1))
  const [generated, setGenerated] = useState<Generated | null>(null)
  const [email, setEmail] = useState('')
  const [revokingUser, setRevokingUser] = useState<AccessUser | null>(null)
  const [revokingPackage, setRevokingPackage] = useState<AccountantPackage | null>(null)

  const month = useQuery({ queryKey: ['accountant', 'month', period], queryFn: () => api.get<AccountantMonth>('/accountant/month', { period }) })
  const packages = useQuery({ queryKey: ['accountant', 'packages'], queryFn: () => api.get<{ packages: AccountantPackage[] }>('/accountant/packages') })
  const users = useQuery({ queryKey: ['accountant', 'users'], queryFn: () => api.get<{ users: AccessUser[] }>('/accountant/users') })

  const generate = useMutation({
    mutationFn: async (): Promise<Generated> => {
      const data = month.data
      if (!data?.pjAccount) throw new Error('escolha a conta da empresa no Motor financeiro antes')
      const issuer = await api.get<{ businessName: string | null }>('/pricing/proposal-issuer').catch(() => ({ businessName: null }))
      const { buildAccountantPdf } = await import('../../lib/accountantPdf')
      const pdf = await buildAccountantPdf(data, issuer.businessName)
      const csv = transactionsCsv(data)
      const folder = `pacotes/${period}/${Date.now()}`
      const pdfPath = `${folder}/fechamento-${period}.pdf`
      const csvPath = `${folder}/extrato-pj-${period}.csv`
      const up1 = await supabase.storage.from(PACKAGE_BUCKET).upload(pdfPath, new Blob([pdf as BlobPart], { type: 'application/pdf' }), { contentType: 'application/pdf' })
      if (up1.error) throw new Error(`falha ao guardar o PDF: ${up1.error.message}`)
      const up2 = await supabase.storage.from(PACKAGE_BUCKET).upload(csvPath, new Blob([csv], { type: 'text/csv' }), { contentType: 'text/csv' })
      if (up2.error) throw new Error(`falha ao guardar o CSV: ${up2.error.message}`)
      const seconds = SHARE_DAYS * 86_400
      const s1 = await supabase.storage.from(PACKAGE_BUCKET).createSignedUrl(pdfPath, seconds)
      const s2 = await supabase.storage.from(PACKAGE_BUCKET).createSignedUrl(csvPath, seconds)
      if (s1.error || s2.error || !s1.data || !s2.data) throw new Error('falha ao criar os links')
      const expiresOn = new Date(Date.now() + seconds * 1000).toLocaleDateString('pt-BR')
      const message = [
        `Olá! Segue o fechamento de ${periodLong(period)} da empresa.`,
        '',
        `Resumo, notas emitidas e extrato (PDF): ${s1.data.signedUrl}`,
        `Extrato da conta PJ (CSV): ${s2.data.signedUrl}`,
        '',
        `Os links valem até ${expiresOn}.`,
      ].join('\n')
      return { pdfUrl: s1.data.signedUrl, csvUrl: s2.data.signedUrl, expiresOn, message }
    },
    onSuccess: (result) => {
      setGenerated(result)
      toast('Pacote do mês gerado')
      queryClient.invalidateQueries({ queryKey: ['accountant', 'packages'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao gerar o pacote', 'error'),
  })

  const revokePackage = useMutation({
    mutationFn: async (p: AccountantPackage) => {
      const { error } = await supabase.storage.from(PACKAGE_BUCKET).remove(p.files.map((f) => `pacotes/${p.period}/${p.createdAt}/${f.name}`))
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      toast('Pacote revogado: os links param de funcionar')
      setRevokingPackage(null)
      queryClient.invalidateQueries({ queryKey: ['accountant', 'packages'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao revogar', 'error'),
  })

  const invite = useMutation({
    mutationFn: () => api.post<AccessUser>('/accountant/users', { email: email.trim() }),
    onSuccess: (u) => {
      toast(`Convite enviado para ${u.email}`)
      setEmail('')
      queryClient.invalidateQueries({ queryKey: ['accountant', 'users'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao convidar', 'error'),
  })
  const revokeUser = useMutation({
    mutationFn: (u: AccessUser) => api.del(`/accountant/users/${u.userId}`),
    onSuccess: () => {
      toast('Acesso revogado')
      setRevokingUser(null)
      queryClient.invalidateQueries({ queryKey: ['accountant', 'users'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao revogar', 'error'),
  })

  const active = (users.data?.users ?? []).filter((u) => !u.revokedAt)
  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim())

  return (
    <>
      <PageHeader
        title="Contador"
        subtitle="O que o contador vê da empresa: só a conta PJ, nada pessoal"
        filters={<PeriodNav period={period} onChange={setPeriod} max={currentPeriod()} />}
        actions={
          <Button variant="primary" icon="send" onClick={() => generate.mutate()} loading={generate.isPending} disabled={!month.data?.pjAccount}>
            Gerar pacote do mês
          </Button>
        }
      />
      <div className="page">
        <div className="stack stack--loose">
          {generated && (
            <Card title={`Pacote de ${periodLong(period)}`} subtitle={`Links válidos até ${generated.expiresOn}. Revogar apaga os arquivos e os links param de funcionar.`}>
              <div className="stack">
                <div className="row row--wrap" style={{ gap: 'var(--sp-2)' }}>
                  <a className="badge badge--info" href={generated.pdfUrl} target="_blank" rel="noreferrer">Abrir PDF</a>
                  <a className="badge badge--info" href={generated.csvUrl} target="_blank" rel="noreferrer">Abrir CSV</a>
                </div>
                <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 'var(--text-xs)', margin: 0, padding: 'var(--sp-3)', background: 'var(--surface-muted)', borderRadius: 'var(--r-md)' }}>{generated.message}</pre>
                <div>
                  <Button
                    icon="copy"
                    onClick={() =>
                      navigator.clipboard
                        .writeText(generated.message)
                        .then(() => toast('Mensagem copiada'))
                        .catch(() => toast('não deu para copiar; selecione o texto acima', 'error'))
                    }
                  >
                    Copiar mensagem para o contador
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {month.isError ? (
            <Card>
              <LoadError onRetry={() => month.refetch()} retrying={month.isFetching} />
            </Card>
          ) : !month.data ? (
            <Card>
              <SkeletonLines lines={6} />
            </Card>
          ) : (
            <AccountantMonthView month={month.data} />
          )}

          <Card title="Pacotes gerados" subtitle="Os mais recentes primeiro. Os links aqui valem 1 hora; o que você enviou ao contador vale 7 dias">
            {packages.isError ? (
              <LoadError onRetry={() => packages.refetch()} retrying={packages.isFetching} />
            ) : !packages.data ? (
              <SkeletonLines lines={2} />
            ) : (
              <PackagesList packages={packages.data.packages} onRevoke={setRevokingPackage} revoking={revokePackage.isPending} />
            )}
          </Card>

          <Card title="Acesso do contador" subtitle="Login próprio, só leitura e só a parte da empresa: o mês, o extrato PJ, as notas e os pacotes">
            <div className="stack">
              {users.isError ? (
                <LoadError onRetry={() => users.refetch()} retrying={users.isFetching} />
              ) : !users.data ? (
                <SkeletonLines lines={2} />
              ) : active.length === 0 ? (
                <p className="muted" style={{ margin: 0, fontSize: 'var(--text-sm)' }}>Ninguém além de você tem acesso.</p>
              ) : (
                <ul className="stack stack--tight">
                  {active.map((u) => (
                    <li key={u.userId} className="row row--between" style={{ gap: 'var(--sp-2)' }}>
                      <span style={{ minWidth: 0, fontSize: 'var(--text-sm)' }}>
                        {u.email}
                        <span className="muted" style={{ display: 'block', fontSize: 'var(--text-xs)' }}>
                          contador · convidado em {new Date(u.invitedAt).toLocaleDateString('pt-BR')}
                        </span>
                      </span>
                      <Button variant="quiet" size="sm" onClick={() => setRevokingUser(u)}>
                        Revogar acesso
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                className="row row--wrap"
                style={{ gap: 'var(--sp-2)', alignItems: 'flex-end' }}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (emailValid) invite.mutate()
                }}
              >
                <div className="grow" style={{ minWidth: 220 }}>
                  <Field label="Convidar contador" hint="O Supabase envia um e-mail com o link para ele criar a senha.">
                    {(id) => <TextInput id={id} type="email" value={email} onChange={setEmail} placeholder="contador@escritorio.com.br" />}
                  </Field>
                </div>
                <Button type="submit" icon="send" loading={invite.isPending} disabled={!emailValid}>
                  Enviar convite
                </Button>
              </form>
            </div>
          </Card>
        </div>
      </div>

      {revokingUser && (
        <ConfirmDeleteModal
          title={`Revogar o acesso de ${revokingUser.email}?`}
          body="A conta dele é apagada e o login para de funcionar na hora. Os pacotes já enviados por link continuam valendo até expirar, a menos que você os revogue."
          confirmLabel="Revogar acesso"
          pending={revokeUser.isPending}
          onCancel={() => setRevokingUser(null)}
          onConfirm={() => revokeUser.mutate(revokingUser)}
        />
      )}
      {revokingPackage && (
        <ConfirmDeleteModal
          title={`Revogar o pacote de ${revokingPackage.period.split('-').reverse().join('/')}?`}
          body="Os arquivos são apagados e os links enviados param de funcionar."
          confirmLabel="Revogar pacote"
          pending={revokePackage.isPending}
          onCancel={() => setRevokingPackage(null)}
          onConfirm={() => revokePackage.mutate(revokingPackage)}
        />
      )}
    </>
  )
}
