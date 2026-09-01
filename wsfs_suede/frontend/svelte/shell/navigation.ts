/**
 * The header's buttons, and where each one goes.
 *
 * Here rather than in the header because it is the app's chrome, not the
 * header's: the header knows how to draw a row of these, and nothing more.
 */
import { goto } from "$app/navigation";
import type { Icon } from "@lucide/svelte";
import ArrowLeftIcon from "@lucide/svelte/icons/arrow-left";
import GraduationCapIcon from "@lucide/svelte/icons/graduation-cap";
import HouseIcon from "@lucide/svelte/icons/house";

export type Destination = {
  label: string;
  icon: typeof Icon;
  go: () => void;
};

export const navigation: Destination[] = [
  //{ label: "Back", icon: ArrowLeftIcon, go: () => history.back() },
  // { label: "Home", icon: HouseIcon, go: () => void goto("/") },
  // {
  //   label: "Courses",
  //   icon: GraduationCapIcon,
  //   go: () => {},
  // },
];
