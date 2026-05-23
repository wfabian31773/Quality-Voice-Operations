// The Governance page used to host three tabs: Evolution, Conversion Funnel,
// and Global Intelligence. Two of the three (Evolution + Global Intelligence)
// depended on the `platform/evolution` and `platform/gin` backend modules,
// which were archived in PR #10 and PR #11. With only the Conversion Funnel
// tab still functional, the tab UI is gone and the page renders the funnel
// directly. The page route at /admin/governance is unchanged and the
// AdminLayout sidebar nav still points here.
import ConversionFunnel from './ConversionFunnel';

export default function Governance() {
  return <ConversionFunnel />;
}
