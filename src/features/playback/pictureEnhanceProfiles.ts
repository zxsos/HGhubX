import type {
  EnhanceStrength,
  SuperResolutionTestDeblock,
  SuperResolutionTestDetailGain,
  SuperResolutionTestFaceMask,
  SuperResolutionTestGrain,
  SuperResolutionTestPortraitContrast,
} from "../../shared/model/store";

type PictureEnhanceProfile = {
  detailGain: SuperResolutionTestDetailGain;
  portraitContrast: SuperResolutionTestPortraitContrast;
  deblock: SuperResolutionTestDeblock;
  grain: SuperResolutionTestGrain;
  faceMask: SuperResolutionTestFaceMask;
};

/** Fixed production profiles for the AI detail path. */
export const PICTURE_ENHANCE_PROFILES: Record<EnhanceStrength, PictureEnhanceProfile> = {
  standard: { detailGain: 1.5, portraitContrast: 0.3, deblock: 0.2, grain: 0.03, faceMask: 1 },
  strong: { detailGain: 2, portraitContrast: 0.4, deblock: 0.2, grain: 0.06, faceMask: 1 },
  extreme: { detailGain: 3, portraitContrast: 0.8, deblock: 0, grain: 0.08, faceMask: 1 },
};
