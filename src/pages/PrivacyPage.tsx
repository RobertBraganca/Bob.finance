import logo from '../assets/logo-red.svg'

const CONTACT = 'robert.s.braganca@gmail.com'

/**
 * Política de privacidade pública (sem login), pedida pelo Google para publicar
 * o app OAuth do Google Agenda (docs/specs/tarefas-comercial-contador, fase 3).
 * Descreve só o que o app faz de fato; se o uso dos dados do Google mudar, esta
 * página muda junto.
 */
export function PrivacyPage() {
  return (
    <main className="legal-page">
      <img src={logo} alt="BOB Finanças" height={26} />
      <h1>Política de privacidade</h1>
      <p className="muted">Atualizada em 23 de outubro de 2026.</p>

      <h2>O que é o BOB Finanças</h2>
      <p>
        Um aplicativo de finanças pessoais e da empresa, de uso privado: só o titular da conta entra, e, se ele convidar, o contador dele, com
        acesso somente leitura à parte da empresa. Não é oferecido ao público.
      </p>

      <h2>Dados do Google</h2>
      <p>Quando o titular conecta a conta Google, o app pede apenas:</p>
      <ul>
        <li>
          <strong>Eventos da agenda</strong> (escopo <code>calendar.events</code>), para criar, atualizar e apagar um evento para cada tarefa
          financeira aberta, como o vencimento de uma conta ou a emissão de uma nota fiscal.
        </li>
        <li>
          <strong>E-mail da conta</strong>, só para mostrar qual conta está conectada.
        </li>
      </ul>
      <p>
        O app só mexe nos eventos que ele mesmo criou. Ele não lê, não copia e não analisa os demais eventos da agenda, nem outros dados da conta
        Google. Os dados do Google não são vendidos, não são compartilhados com terceiros e não são usados para publicidade nem para treinar
        modelos de inteligência artificial.
      </p>
      <p>
        O token de acesso fica guardado no servidor do app (Supabase), protegido e fora do alcance do navegador. O uso dos dados recebidos das
        APIs do Google segue a{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Política de dados do usuário dos serviços de API do Google
        </a>
        , incluindo os requisitos de uso limitado.
      </p>

      <h2>Como desconectar</h2>
      <p>
        Na página Tarefas do app, o botão Desconectar apaga os eventos que o app criou, revoga o acesso no Google e apaga o token. O acesso também
        pode ser revogado a qualquer momento em{' '}
        <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
          myaccount.google.com/permissions
        </a>
        .
      </p>

      <h2>Demais dados</h2>
      <p>
        Os dados financeiros registrados no app (lançamentos, contas, clientes) ficam no banco de dados do titular, com acesso restrito a ele e,
        na parte da empresa, ao contador que ele convidar. Nada é enviado a terceiros, exceto aos serviços que o próprio titular configurar, como
        a conexão com o banco.
      </p>

      <h2>Contato</h2>
      <p>
        Dúvidas ou pedidos sobre estes dados: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </main>
  )
}
