import LegalPolicyPage from "../components/LegalPolicyPage";
import privacyMarkdown from "../legal-policies/privacy.md?raw";
import { withDefaultSocialImage } from "../seo";

export const meta = () =>
  withDefaultSocialImage([
    {
      title: "FB Factory Privacy Policy",
    },
    {
      name: "description",
      content:
        "Standalone privacy policy for FB Factory hosted applications and related services.",
    },
  ]);

export default function PrivacyPage() {
  return <LegalPolicyPage markdown={privacyMarkdown} />;
}
