import { useEffect, useId, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useUserProfile, type AccountType, type UserProfile } from '../lib/store'
import { Button, Card, Icon, Segmented, TextInput, useToast } from '../components/ui'
import { PageHeader } from '../components/shell/Shell'
import { Link } from 'react-router-dom'

export function ProfilePage() {
  const profile = useUserProfile()
  const queryClient = useQueryClient()
  const toast = useToast()
  const nameFieldId = useId()

  const [displayName, setDisplayName] = useState('')
  const [accountType, setAccountType] = useState<AccountType>('freelancer')

  // Preenche o formulário assim que o perfil carrega — só uma vez por
  // resposta nova, pra não sobrescrever o que o usuário já está digitando
  // se a query revalidar em segundo plano.
  useEffect(() => {
    if (!profile.data) return
    setDisplayName(profile.data.profile.displayName ?? '')
    setAccountType(profile.data.profile.accountType)
  }, [profile.data])

  const save = useMutation({
    mutationFn: () =>
      api.put<{ profile: UserProfile }>('/profile', {
        displayName: displayName.trim().length > 0 ? displayName.trim() : null,
        accountType,
      }),
    onSuccess: () => {
      toast('Perfil salvo')
      queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
    onError: (error) => toast(error instanceof Error ? error.message : 'falha ao salvar', 'error'),
  })

  return (
    <>
      <PageHeader title="Perfil" subtitle="Nome de exibição e tipo de uso do app" />
      <div className="page stack stack--loose">
        <Card title="Como te chamamos" subtitle="Aparece na saudação da Visão geral">
          <div className="field">
            <label className="field__label" htmlFor={nameFieldId}>Nome</label>
            <TextInput id={nameFieldId} value={displayName} onChange={setDisplayName} placeholder="Seu nome" />
            <span className="field__hint">Em branco, a saudação não usa nome nenhum.</span>
          </div>
        </Card>

        <Card
          title="Tipo de uso"
          subtitle="Por enquanto, só decide quais telas aparecem no menu. No futuro, cada tipo vira um plano de assinatura próprio."
        >
          <Segmented
            ariaLabel="Tipo de uso"
            value={accountType}
            onChange={setAccountType}
            options={[
              { value: 'personal', label: 'Pessoal' },
              { value: 'freelancer', label: 'Freelancer' },
            ]}
          />
          {accountType === 'personal' && (
            <p className="chart__note" style={{ marginTop: 'var(--sp-2)' }}>
              <Icon name="info" size={12} /> Precificação e Receita de parceiros saem do menu lateral.
            </p>
          )}
        </Card>

        {/* Os % do orçamento e as TAGs dos grupos moram em Orçamento › Ajustar; daqui é só o atalho. */}
        <Card title="Metas financeiras" subtitle="Quanto da renda vai para cada grupo do orçamento">
          <Link to="/metas/ajustar" className="btn btn--ghost btn--sm">
            <Icon name="target" size={13} />
            Ajustar orçamento
          </Link>
        </Card>

        <div className="row">
          <Button variant="primary" icon="check" onClick={() => save.mutate()} disabled={save.isPending} loading={save.isPending}>
            Salvar
          </Button>
        </div>
      </div>
    </>
  )
}
