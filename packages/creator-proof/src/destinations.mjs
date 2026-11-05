import { fail } from './errors.mjs';

// Place names only. Meta's forms change, so none of these is a web address.
// ReportFraud.ftc.gov and IC3.gov are the two names the plan requires for fans
// who already gave. They are names, not links to open from this kit.

export const COPYRIGHT_FORM = "Meta's copyright report form";
export const IMPERSONATION_FORM = "Meta's impersonation report form";
export const IN_APP_REPORT = "the platform's in-app report on each copy";
export const PAYMENT_UNKNOWN = 'the payment service on the fake link';
export const FAN_PLACES = 'ReportFraud.ftc.gov and IC3.gov';
export const ID_NOTE = 'If they ask for ID, send it to Meta directly. It never goes through True Convo.';

function formSteps(place) {
  return [
    `Open ${place}.`,
    'Paste the drafted text for this place.',
    'Attach the files named in the originals table.',
    'Keep the case number they give you.',
  ];
}

function paymentPlace(paymentService) {
  if (paymentService && typeof paymentService.name === 'string' && paymentService.name.trim() !== '') {
    return {
      id: 'payment',
      name: paymentService.name,
      missing: false,
      steps: [
        `Open the fraud report at ${paymentService.name}.`,
        'Paste the drafted text for this place.',
        'Name the account shown on the fake link.',
        'Keep the case number they give you.',
      ],
    };
  }
  return {
    id: 'payment',
    name: PAYMENT_UNKNOWN,
    missing: true,
    steps: [
      'Open the fraud report at the payment service on the fake link.',
      'Paste the drafted text for this place.',
      'Name the account shown on the fake link.',
      'Keep the case number they give you.',
    ],
  };
}

export function placesFor(kind, paymentService) {
  const copyright = { id: 'copyright', name: COPYRIGHT_FORM, steps: formSteps(COPYRIGHT_FORM) };
  const impersonation = {
    id: 'impersonation',
    name: IMPERSONATION_FORM,
    steps: [...formSteps(IMPERSONATION_FORM), ID_NOTE],
    idNote: ID_NOTE,
  };
  const inApp = { id: 'in-app', name: IN_APP_REPORT, steps: formSteps(IN_APP_REPORT) };
  const fans = {
    id: 'fans',
    name: FAN_PLACES,
    steps: [
      'Tell fans who already sent money to report the scam at ReportFraud.ftc.gov and at IC3.gov.',
    ],
  };
  if (kind === 'stolen-video') return [copyright, inApp];
  if (kind === 'impersonation') return [impersonation, inApp];
  if (kind === 'fake-fundraiser') return [copyright, impersonation, inApp, paymentPlace(paymentService), fans];
  fail('The case kind must be stolen-video, impersonation or fake-fundraiser.');
}
