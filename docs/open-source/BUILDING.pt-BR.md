<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.pt-BR.md)
<!-- doc-navigation:end -->

# Construa a fonte

O artefato público é a origem, não uma imagem de dispositivo off-line pré-criada. Uma compilação de origem pode baixar dependências; a instalação usando um pacote completo preparado permanece offline. Nenhum dos processos precisa de um ViKey SDK ou de uma chave USB.

Para uma instalação completa do dispositivo, comece com o [início rápido](../../README.pt-BR.md#install) raiz e o [instalador de origem](../../install/SOURCE-INSTALL.pt-BR.md): `sudo bash install/from-source.sh` faz downloads, compilações, pacotes e instalações em um novo Spark compatível. A construção da web de desenvolvimento abaixo não é aquele instalador e não inicia o produto completo.

## Desenvolvimento

Use Node.js 24, pnpm 11.1.3 (consulte root `package.json`), Python 3.10+ e a versão Go declarada em cada `go.mod` (agente de nó atualmente 1.26). Em uma máquina de construção:

Uma exportação de origem deliberadamente não tem histórico privado do Git. Antes de executar as ferramentas de origem nessa árvore exportada, inicialize seu próprio repositório e confirme sua árvore revisada (`git init`, `git add .`, `git commit`). Um clone público normal do Git não precisa desta etapa. Use esse novo commit como identidade de construção; não reivindique que uma árvore exportada e modificada seja o antigo commit de entrega.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

A construção da web é uma verificação de compilação, não de aceitação do produto. Os serviços de tempo de execução usam Dockerfiles em `deploy/`. A execução de DGX Spark requer Linux ARM64 e o ambiente NVIDIA/Docker existente. Uma verificação de fonte de desktop não substitui esse hardware. Não use scripts de laboratório históricos como instaladores.

Os auxiliares de construção de fábrica do Python também exigem PyYAML; veja a simulação de dependência do instalador. Não é necessário nenhum disco de sistema operacional instalado ou conta de desenvolvedor.

## Entradas compiladas excluídas

O exportador omite arquivos binários, mesmo quando sua extensão parece inofensiva:

- Construa `services/node-agent` e seu auxiliar `cmd/factory-worker-spec` da fonte Go; o executável raiz do repositório `node-agent` não é uma entrada de origem.
- APKs de dispositivos Android e arquivos de assinatura não são enviados. Sua origem e manifestos em `tools/fixtures/` permanecem disponíveis para compilações de teste locais.
- A versão de transmissão do dispositivo atual usa `deploy/appliance/wireless-casting-plugin.Dockerfile`. Ele não precisa dos antigos arquivos de pacotes Alpine. Se você usar o plug-in independente Dockerfile, obtenha os pacotes exatos identificados em [seu manifesto de soma de verificação upstream](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json) e verifique seus valores SHA-256 antes de compilar. Nunca substitua um pacote arbitrário quando o artefato upstream fixado não estiver disponível.
- O módulo do navegador LiveKit e sua licença permanecem no diretório de fontes públicas do plugin; o arquivo npm `.tgz` redundante não é enviado.

Estas são exclusões de distribuição de origem, não alterações no dispositivo em execução.

## Pacote off-line completo

Comece com [o pipeline de origem pública](../../install/PUBLIC-BUILD.pt-BR.md). Ele fornece as imagens pai públicas e as dependências de tempo de execução criadas no código-fonte; não é necessária uma instalação prévia do desenvolvedor. Receitas históricas de imagens em camadas não são o ponto de entrada para novas instalações.

Siga [install/README.md](../../install/README.pt-BR.md) para compilações de imagens de aplicativos, ferramentas de host convidado, pacotes de host offline, coleta de ativos e empacotamento final. O dispositivo de destino não busca dependências nem substitui o Docker/NVIDIA. Defina entradas de construção para seu commit de origem real, IDs de conteúdo ARM64 OCI e caminhos de ativos limpos. Nenhum IP, conta, certificado ou volume do host de desenvolvimento é necessário. Os pesos do modelo e os ativos de convidado/tempo de execução são obtidos separadamente das fontes upstream exatas identificadas em [components.json](components.json) e nos bloqueios do repositório. Preservar suas licenças e avisos de origem necessários.

**A disponibilidade da fonte não é uma autorização de redistribuição binária.** O contrato atual do pacote off-line completo inclui um tempo de execução do Google Android; sua evidência de instalação privada não é permissão para distribuir GMS. O empacotador existente é mantido inalterado, mas tal pacote não é um download público aprovado, a menos que esses direitos sejam obtidos. Uma edição binária pública somente AOSP seria uma mudança de pacote com escopo separado, não substituída silenciosamente aqui. Os arquivos ISO do Windows/Linux são fornecidos por cada usuário; nenhum convidado de teste instalado ou estados de conta são entradas de construção pública.
