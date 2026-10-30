<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.pt-BR.md)
<!-- doc-navigation:end -->

# Instalar a partir de um clone público

Este ponto de entrada prepara as entradas públicas necessárias, constrói as imagens do aplicativo e produz um pacote completo antes de instalá-lo. O progresso da construção é retomável; apenas o resultado final da prontidão para instalação indica um aparelho instalado. O sucesso do download ou da simulação por si só não o faz.

Mantenha modelos gerados, imagens de contêiner, pacotes de instalação, registros de teste e credenciais fora do repositório. A disponibilidade de espelhos de terceiros não é garantida; caches portáteis verificados e pacotes offline são descritos abaixo.

Em um DGX Spark novo com Ubuntu 24.04, trabalhando com Docker/Compose, NVIDIA e KVM, clone o repositório público e execute a partir de sua raiz:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Para uma rede da China continental onde os pontos finais do modelo/imagem upstream não podem ser alcançados, use o mesmo ponto de entrada com fontes de download regionais:

```sh
sudo bash install/from-source.sh --region cn
```

Esta é uma **compilação de origem on-line seguida de instalação off-line**, não uma compilação de origem off-line. Ele prepara automaticamente as ferramentas de compilação ausentes, baixa as seis entradas do modelo, cria e monta o Android e todas as imagens do aplicativo, quantiza os dois modelos de origem, coleta pacotes de firmware/host, cria o pacote offline completo e executa o instalador existente. Ele não substitui o Docker/NVIDIA, não reinicia o daemon do Docker, limpa uma instalação existente ou altera as configurações de roteamento do host, DNS ou VPN. Modelos, estados de login de convidado e site de marketing privado não são retirados de outra instalação.

A área de trabalho padrão é `/var/tmp/teamaibox-source-build`; caches de download e logs por estágio ficam lá, fora do clone. O padrão de instalação é `/srv/teamaibox/installation`. Espere grandes downloads e várias centenas de GB de uso temporário do disco. O carregamento do modelo e a quantização da GPU podem levar muito tempo; nenhum tempo de conclusão fixo é prometido.

## Retomar a instalação e verificar o status

Se interrompido, **execute novamente exatamente o mesmo comando**. Mantenha o espaço de trabalho. Uma compilação em execução exclui outro gravador; arquivos e imagens de estágio concluídos são verificados antes da reutilização. As tentativas falhadas permanecem disponíveis para diagnóstico, enquanto a próxima tentativa executa apenas o estágio falhado. Os intervalos de bytes do modelo e os arquivos verificados são retidos. `state.json` identifica o estágio atual e seu diretório de log. Os downloads de modelos oficiais usam simultaneidade limitada de arquivos/intervalos; fontes regionais usam simultaneidade conservadora para reduzir a limitação de taxas. Relatórios de progresso de bytes por arquivo transferidos ou intervalos reutilizados separadamente da verificação final de hash do editor. A compilação da ferramenta convidada também funciona em um serviço do sistema sem login inicial: ela cria caches de construção isolados fora dos ativos de instalação resultantes.

As alterações de origem requerem um novo `--work-dir`; reutilize o cache de download com `--cache-dir /path/to/public-cache`. A impressão digital de origem evita a combinação silenciosa de saídas de códigos diferentes. Uma instalação existente não é um convite para redefini-la: apenas a instalação do mesmo pacote deste espaço de trabalho pode ser retomada; outras instalações devem usar seu processo de atualização.

Modos úteis:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` é somente leitura e não afirma que os downloads serão bem-sucedidos. Somente download e somente compilação explicitamente não afirmam estar prontos para instalação.

## Fontes regionais e integridade

O modo China usa `https://hf-mirror.com` para transferência de modelo e `https://docker.m.daocloud.io` para entradas do Docker Hub fixadas por resumo. Estes são espelhos de terceiros, não serviços operados pela Weerocks ou pelos editores do modelo. O modelo de commit do Git é fixado pelo perfil do produto; sua árvore Git verificada e ponteiros LFS estabelecem os tamanhos de arquivo e hashes esperados. A resposta da API do espelho por si só não pode estabelecer confiança. Docker verifica resumos de manifesto/camada fixados. Tags não fixadas não são redirecionadas automaticamente (a ferramenta de compilação Go possui um bloqueio de resumo explícito). As imagens NVIDIA permanecem no registro do editor. A verificação TLS permanece habilitada e nenhum token de conta é enviado aos espelhos do modelo.

Você pode selecionar suas próprias origens HTTPS usando `--model-endpoint` and `--registry-mirror`. Os valores de endpoint não devem incluir credenciais ou parâmetros de consulta. O wrapper do Docker com escopo se aplica apenas a este processo de construção, não ao daemon do sistema ou a outros projetos. Os metadados do SDK e os arquivos de licença ainda vêm de seus editores HTTPS autorizados; um espelho não pode inventar hashes.

Os espelhos podem ter taxa limitada ou estar indisponíveis. Os downloads de modelos são executados com simultaneidade limitada e respeitam os tempos de espera. Nenhum script pode garantir a conectividade com todos os upstream em todas as redes. Se ambas as rotas não estiverem disponíveis, prepare os downloads ou o pacote completo em uma máquina compatível acessível e copie-os:

- `--download-models-only --cache-dir <public-cache>` prepara arquivos de modelo verificados e caches recuperáveis. Copie esse diretório e passe-o com `--cache-dir` no destino. Cada modelo reutilizado é verificado em relação à sua identidade fixada. Este cache **não** é um pacote de instalação offline completo.
- `--build-only` prepara o pacote completo para instalação offline. Copie seu tar e soma de verificação, verifique e descompacte e execute `sudo ./install.sh` dentro dele. Esta é a rota confiável de host desconectado; não requer uma VPN no destino ou acesso a uma caixa de desenvolvimento.

Nunca copie um diretório de dados ativo do Docker, discos convidados, perfis de navegador, bancos de dados de contas, credenciais ou caches privados como substitutos para entradas públicas. Não desative somas de verificação nem aceite uma página de login/desafio como arquivo de modelo.

## Licenciamento e primeiro uso

Revise `THIRD_PARTY_NOTICES.md`, os termos do Android SDK e as licenças de modelo individuais antes de criar. O download de componentes de terceiros não os transforma em MIT ativos nem concede direitos de certificação/redistribuição ao Google. A mídia ISO do Windows/Linux ainda é fornecida pelo usuário. O login de fábrica permanece `admin/admin`; altere-o antes de expor o aparelho. O instalador existente gera credenciais de serviço independentes e relata a disponibilidade real.

Após a conclusão, abra `https://<BOX_LAN_IP>/` na mesma LAN; substitua o endereço de rede física atual do Spark, não uma ponte Docker ou endereço VPN. O `state.json` do espaço de trabalho de origem registra o progresso da construção. O `/srv/teamaibox/installation/readiness.json` instalado registra verificações de instalação. Nem uma compilação bem-sucedida nem uma verificação de integridade do contêiner de escuta substituem a operação visível de ponta a ponta de um aplicativo.

O tempo de execução de transmissão deve conter o receptor UxPlay, executáveis privados de descoberta D-Bus e Avahi, bem como seus plug-ins de mídia. A compilação final da imagem pública verifica esses executáveis; uma biblioteca cliente por si só é insuficiente. Uma nova instalação registra o proxy e o gateway da área de trabalho com os outros dependentes do namespace da rede da API para que as atualizações agrupadas da API possam reter o caminho de conexão da área de trabalho. Não recrie apenas um subconjunto desse grupo durante a manutenção.
