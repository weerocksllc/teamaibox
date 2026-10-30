<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.pt-BR.md)
<!-- doc-navigation:end -->

# Team AI Box ferramentas de pacote off-line

O instalador original é licenciado por MIT. Os pacotes incluem a licença raiz, inventário de terceiros e textos de licença em seu inventário de hash de arquivo. Isso não relicencia modelos, serviços do Google, drivers ou dependências de contêiner como MIT. Leia os [limites de lançamento](../docs/open-source/RELEASING.pt-BR.md) antes da distribuição; um pacote de teste completo existente não possui automaticamente autorização de redistribuição.

Os clientes executam **`sudo ./install.sh` dentro do pacote preparado**. Os mantenedores constroem esse pacote com `build-package.sh`. Os clientes offline não precisam de Git, Node, Go, pip ou repositórios de pacotes públicos.

Para download, compilação e instalação automática de um clone público, execute `sudo bash install/from-source.sh`. As redes na China podem usar `--region cn`. Consulte [SOURCE-INSTALL.md](SOURCE-INSTALL.pt-BR.md) para operação, retomada e transferência offline. O currículo é suportado; somente o resultado da prontidão final estabelece a conclusão da instalação. Uma simulação ou download bem-sucedido não é suficiente.

O alvo é um DGX Spark novo com seu sistema Ubuntu 24.04 ARM64 de fábrica e Docker Engine funcional, Compose v2, NVIDIA Container Toolkit/GPU e KVM. O instalador não substitui o Docker/NVIDIA, não reinicia o Docker nem copia contas, bancos de dados, chaves ou máquinas virtuais de um dispositivo de desenvolvimento.

> Os registros de aceitação de instalação privada permanecem no repositório histórico de desenvolvimento. Eles não são arquivos de origem pública nem entradas de construção. As evidências existentes de primeira instalação, retomada e recuperação de inicialização não são executadas novamente apenas para publicação de origem e não qualificam imagens arbitrárias recém-criadas nem concedem direitos de redistribuição para binários de terceiros.

## Mantenedores: preparem entradas de lançamento

**Para uma nova compilação pública do GitHub, comece com [PUBLIC-BUILD.md](PUBLIC-BUILD.pt-BR.md).** Ele abrange imagens públicas, tempos de execução de câmera, downloads/quantização de modelos e firmware sem exigir imagens de um dispositivo de desenvolvimento. Os auxiliares de imagem em camadas abaixo suportam atualizações incrementais de artefatos verificados; eles não são pré-requisitos para uma nova construção.

A preparação pode usar a internet. A instalação do pacote entregue não deve baixar dependências. O host de empacotamento precisa de Python 3.10+, PyYAML, Git, Docker, `dpkg-deb` e armazenamento suficiente. Os modelos e imagens podem ser grandes; o empacotador retém a árvore extraída e `.tar`, estimando o espaço a partir das entradas reais. Ele não verifica todo um dispositivo de desenvolvimento nem exporta camadas graváveis ​​de contêineres em execução.

1. Prepare imagens ARM64 de **uma versão** para todas as funções necessárias. Use os pontos de entrada de construção em `deploy/images/`, `deploy/appliance/` e os diretórios guest/model correspondentes. A API da plataforma, o agente do nó, o agendador e o controlador do agente devem suportar IDs de imagem locais; a imagem PostgreSQL deve conter o manifesto de migração atual, incluindo a migração 116. O empacotador não compila uma imagem antiga arbitrária em uma imagem atual. Com imagens pai da mesma versão verificadas, use `build_runtime_images.py --bases … --node-agent-binary … --output …` para construir as cinco imagens sucessoras. `--bases` é um mapa JSON de função para ID de imagem completa. Primeiro crie o Node Agent com `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`. Este auxiliar proíbe pulls/criações de rede, registra identidades pai/fonte e cria novas imagens sem implantar ou alterar tags ativas. ROMs limpas do Android também precisam do adaptador de rede de controle atual. Use `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>` para adicionar `phone_network.py` a ambas as camadas sucessoras de ROM sem acesso à rede ou alterações de dados ROM. Ele registra IDs de imagem exatos e resumos de origem. Vincule o sidecar do Android aos dois novos IDs, não aos anteriores. Crie a web e nove aplicativos oficiais usando `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`. Primeiro construa a web conforme especificado por `apps/web/package.json`. O auxiliar usa Dockerfiles de produção, corrige o diretório da web em `/opt/teamaibox/web` e compara os arquivos de imagem com os hashes de entrada de compilação atuais. Não presuma que uma imagem de contêiner de desenvolvimento seja uma construção web completa: ela pode depender de variáveis ​​extras de diretório estático ou conter um diretório antigo. Este auxiliar offline não é implementado. Coloque todos os dez novos IDs de imagem nas entradas de lançamento.
2. Colete diretórios completos e limpos para seis modelos: configuração, fragmentos, tokenizadores, código necessário e licenças. Prepare também duas imagens Android limpas, UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` e os scripts de tempo de execução de desenho. Não colete diretórios de instâncias telefônicas, discos de usuários, estado de login do Google, ISOs de usuários ou credenciais globais. As ROMs do Android já estão dentro de `phone-runtime` / `phone-google-runtime`; não copie um segundo disco. Os diretórios de ativos `android-standard` / `android-google` contêm apenas procedência, licenças e `manifest.json`: `schemaVersion: 1`, `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"` or `"google-play"` e `runtimeImageId: "sha256:…"`. O ID deve corresponder à imagem de tempo de execução exportada. O diretório do driver contém apenas `virtio.iso`; um diretório de desenvolvimento que também contém `windows.iso` é rejeitado.
3. Construa as duas ferramentas de host Linux ARM64 incluídas sem instalá-las no host de construção:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. Em um host de compilação ARM64 conectado à Internet, colete as dependências da ferramenta host usando uma imagem local explícita do Ubuntu 24.04. Use o ID da imagem verificado nesse host, e não um ID copiado de um dispositivo de desenvolvimento:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Colete apenas dependências para cryptsetup, ext4, USB/câmeras, ferramentas de imagem QEMU, rede e pequenos utilitários de sistema. Docker, containerd, NVIDIA, CUDA e pacotes de substituição de kernel são proibidos. A instalação fornece apenas ferramentas faltantes; apt lê o repositório de arquivos local do pacote com `--no-download --no-remove`, sem um substituto online.

5. Gere o manifesto de entrada de liberação e forneça **caminhos de artefatos explícitos e IDs de conteúdo de imagem local**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   O modelo inclui todas as 41 funções de imagem e 12 categorias de ativos externos; outro ativo de fábrica é gerado pelas ferramentas. Os espaços reservados não podem inserir um pacote. `sourceCommit` deve corresponder à finalização da compra, `agentVersion` à versão real do agente e `hostPackageCollection` à etapa 4 `collection.json`. Os caminhos do host de compilação são entradas de coleção, não configuração de tempo de execução do cliente. Use o gerador de fábrica atual: as rotas `drawing.automatic` / `drawing.fast` da UI de desenho devem corresponder à configuração do modelo local. A saúde do trabalhador ou uma chamada direta de modelo por si só não estabelecem a prontidão para aplicação. A embalagem rejeita modelos de fábrica obsoletos sem esses mapeamentos.

O contrato de função de imagem é relatado por `python3 install/package.py --describe-contract`:

- Core, web, team drive, mensagens, gateways, agendador, manutenção, plug-ins, sandboxes de agentes dinâmicos e gateways de origem de pacotes.
- Nove plug-ins de aplicativos, seis trabalhadores modelo de escritório e tempos de execução de ASR/alto-falante sob demanda.
- Android padrão, Google Android, tempo de execução do computador e gateways de exibição/áudio da web.
- Receptor de casting, processamento de mídia e SFU.

Duas funções podem compartilhar um ID de conteúdo de imagem; seu arquivo é exportado apenas uma vez. Os índices de fragmentos do modelo também são verificados: hashes de arquivo correspondentes não justificam a falta de um fragmento. As ferramentas de host devem ser binários ARM64 ELF reais.

## Construa o pacote

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

As saídas são `teamaibox-<releaseId>-linux-arm64.tar`, seu arquivo `.sha256` e o diretório extraído. A cópia, a exportação de imagens, o hash e o arquivamento ocorrem em um diretório temporário antes da publicação da soma de verificação final. As saídas existentes não são substituídas; uma compilação interrompida não deve parecer uma versão completa. Para alterações somente do instalador com identidades de imagem inalteradas, use `--image-cache <previous-extracted-package>`. Todo o pacote antigo é verificado antes que seus arquivos sejam reutilizados pelo ID de imagem real, e o novo pacote é verificado novamente. Nenhum dado é obtido de uma instalação antiga ou de uma camada gravável de contêiner. Isso evita exportar novamente centenas de GB de imagens idênticas.

Uma versão normal exige que seus arquivos de origem incluídos no pacote pertençam ao commit declarado do Git. Um `--allow-working-tree` explícito cria um candidato de desenvolvimento; seu manifesto registra `candidate: true` e arquivos alterados. Passar pela aceitação focada não transforma uma fonte não comprometida em um lançamento publicado.

Layout do pacote:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Verifique de forma independente com `./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`. Isso verifica a integridade; isso não prova uma inicialização bem-sucedida em novo hardware.

## Clientes: instalação offline e currículo

Leia o [guia de instalação do pacote](PACKAGE-README.pt-BR.md). A raiz padrão é `/srv/teamaibox/installation`. LUKS/ext4 é criado apenas dentro do novo `volume/data.img`, não no disco do sistema ou nos discos existentes. O pool de dados usa o armazenamento disponível menos uma margem de segurança física, e não um limite fixo de 256 GiB. Modelos, arquivos de negócios e dados de convidados residem no volume criptografado; O Docker existente gerencia imagens de contêiner.

Uma nova instalação cria o administrador `admin` com a senha inicial `admin`. Os usuários comuns são criados pelo administrador. Altere a senha inicial antes da entrega/utilização. Isso se aplica apenas a um banco de dados de contas vazio: retomar, executar novamente, reinicializar e atualizar não redefine contas ou senhas existentes. A identidade do dispositivo, as credenciais de serviço, os certificados e os códigos de recuperação do administrador são gerados de forma independente e não copiados de outro dispositivo. A preparação inicial do cache do kernel da GPU é executada no dispositivo usando ferramentas e modelos incluídos; caches compatíveis são retidos. A recuperação de inicialização restaura primeiro os dados e os serviços do dispositivo, depois os serviços principais e os trabalhadores de IA individuais. O instalador é executado somente durante a instalação; ele não adiciona nenhum gerenciador de instalação residente.

Após a interrupção, repita o comando original. As etapas concluídas são verificadas; não esconda conflitos excluindo dados ou recriando contêineres. A reexecução de uma instalação concluída da mesma versão apenas a verifica; versões diferentes usam o caminho de atualização formal. Os detalhes da falha estão em `install-state.json`, `readiness.json` e os registros de preparação na raiz da instalação.

## Limites de verificação

Os testes específicos do instalador usam pequenos artefatos estruturais, arquivos temporários e bancos de dados offline/daemons Docker isolados. Eles não devem acessar bancos de dados empresariais nem montar discos VM existentes. Uma instalação realmente nova requer um DGX Spark compatível explicitamente designado para esse propósito; não apague um eletrodoméstico. A aceitação cobre inicialização mínima, retomada e recuperação de inicialização para a nova instalação, e não testes de negócios não relacionados. A preparação para liberação do código-fonte em si não apaga, reinstala ou implanta dispositivos existentes.

Em um host de compilação, execute `sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>` para importar o pacote completo para um daemon Docker separado com cache vazio e sem rede pública. Ele não invoca o script de nova instalação, não usa uma GPU, não monta diretórios de clientes nem reinicia o Docker do sistema. Seu relatório não reivindica explicitamente a instalação completa do hardware. As imagens de teste permanecem no diretório de teste dedicado, precisam de espaço em disco adicional e não entram no armazenamento de imagens do Docker do sistema.
