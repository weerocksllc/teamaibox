<!-- doc-navigation:start -->
[English](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.en.md) · [简体中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.md) · [繁體中文](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.zh-TW.md) · [日本語](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ja.md) · [한국어](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ko.md) · [Français](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.fr.md) · [Deutsch](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.de.md) · [Español](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.es.md) · [Português](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.pt-BR.md) · [Русский](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ru.md) · [العربية](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.ar.md) · [हिन्दी](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.hi.md) · [Bahasa Indonesia](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.id.md) · [Italiano](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.it.md) · [Türkçe](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.tr.md) · [Tiếng Việt](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.vi.md) · [ไทย](https://github.com/weerocksllc/teamaibox/blob/main/install/PACKAGE-README.th.md)

[Team AI Box — README](https://github.com/weerocksllc/teamaibox/blob/main/README.pt-BR.md)
<!-- doc-navigation:end -->

# Team AI Box pacote de instalação off-line

A licença para o código original está no pacote `LICENSE`. Os componentes de terceiros mantêm suas licenças originais; consulte `THIRD_PARTY_NOTICES.md` and `docs/open-source/components.json`. MIT não concede direitos de redistribuição adicionais para serviços do Google, Windows, pesos de modelo ou marcas de terceiros. A aprovação nas verificações de integridade do pacote não estabelece permissão de redistribuição para todos os componentes.

Este pacote é para um DGX Spark novo que mantém um sistema Linux de fábrica compatível. Ele usa o ambiente Docker, Compose e NVIDIA GPU existente sem substituí-los ou formatar o disco do sistema.

## Instalação

Verifique o arquivo usando o arquivo `.sha256` que o acompanha e extraia-o:

```sh
sha256sum -c teamaibox-<releaseId>-linux-arm64.tar.sha256
tar -xf teamaibox-<releaseId>-linux-arm64.tar
cd teamaibox-<releaseId>-linux-arm64
sudo ./install.sh
```

A instalação normal não precisa de acesso público à Internet nem de edições manuais de variáveis de ambiente. O instalador fornece as ferramentas necessárias, gera configuração local independente, inicializa um novo banco de dados e inicia serviços. O carregamento inicial do modelo pode levar algum tempo; um indicador de carregamento não é uma confirmação de instalação bem-sucedida.

Execute `sudo ./install.sh --check` para verificar o ambiente e o pacote sem instalar. `./install.sh --verify-package` verifica apenas o conteúdo do pacote e também pode ser executado na estação de trabalho de empacotamento. Use `--installation-root /dedicated/path/installation` para especificar uma nova raiz de instalação; nunca aponte para dados existentes.

## Interrupções e dados existentes

Após uma falha ou interrupção, resolva o problema relatado e repita o comando original. Não exclua o diretório de instalação. O instalador preserva a identidade e os dados gerados. A reexecução de uma instalação completa da mesma versão apenas verifica seu estado. Outras versões usam o caminho de atualização formal, não o apagamento e a reinstalação. Não há opção de substituição forçada.

## Primeiro uso

Abra o endereço HTTPS no IP atual do dispositivo e faça login:

- Nome de usuário do administrador: `admin`
- Senha inicial: `admin`

O instalador cria este administrador automaticamente; nenhuma extração de token de configuração ou registro manual é necessária. A senha inicial é pública e simples: altere-a na gestão de usuários antes da entrega/utilização. Os usuários comuns não possuem conta padrão e são criados pelo administrador. Isto se aplica apenas a um banco de dados de contas vazio; retomar, executar novamente, reinicializar e atualizar nunca redefine contas ou senhas existentes para os padrões. O código de recuperação do administrador gerado independentemente é armazenado na raiz da instalação em `secrets/initial-owner-recovery.json`, legível apenas pela raiz. Nunca envie códigos de recuperação para chats, tickets ou registros públicos. As instalações existentes não geram nem substituem códigos de recuperação. Para o certificado HTTPS emitido localmente, configure a confiança do navegador de acordo com as instruções da CA do administrador. Um nome em um certificado não garante a resolução LAN DNS/mDNS. O certificado público da CA local normalmente está em `/srv/teamaibox/installation/https/ca.crt`. Distribua apenas esse certificado público, nunca a chave privada ao lado dele.

A instalação não inclui máquinas virtuais existentes, estado de login do Google ou arquivos de usuário. Os usuários carregam ISOs do Windows/Linux ou os selecionam na unidade da equipe e, em seguida, instalam eles próprios os sistemas convidados. Google Play e APIs externas exigem acesso à Internet e não estão incluídas na promessa de disponibilidade offline.

Os textos de licença dos componentes são mantidos com seus recursos de lançamento. Direitos autorais © Weerocks LLC. Contato: teamaibox@weerocks.llc.
