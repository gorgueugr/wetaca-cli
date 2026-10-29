// GraphQL documents used by wetaca-cli.
// Field names verified against wetaca.com's web bundle (web app v49.6.0, oct 2026).
// Keep in sync with docs/cli-spec.md. The API is unofficial and can drift.

export const CUSTOMER = `query customer {
  customer { id firstname lastname email phoneNumber }
}`;

export const TOKEN_IS_VALID = `query tokenIsValid($token: String!) {
  tokenIsValid(token: $token)
}`;

export const SESSION_BY_PASSWORD = `query sessionTokenByPassword($login: String!, $password: String!, $segmentSlug: String) {
  sessionTokenData: sessionTokenByPassword(username: $login, password: $password, segmentSlug: $segmentSlug) {
    customerId
    jwtToken
    requirePhoneNumber
  }
}`;

export const SIGN_UP_WITH_GOOGLE = `mutation signUpWithGoogle($code: String!, $redirectUri: String!, $segmentSlug: String, $locale: String) {
  signUpWithGoogle(code: $code, redirectUri: $redirectUri, segmentSlug: $segmentSlug, locale: $locale) {
    ... on GoogleSignupSuccess { jwtToken isNewCustomer }
    ... on GoogleNeedsLinkage { email tokenId requireLinkAccounts requirePhoneNumber passSet }
  }
}`;

export const SUBSCRIBER_STATUS = `query subscriberAccountStatus {
  subscriptionAccountByCustomer { id isActive cancelled pausedUntil nextSuggestionSkipped }
}`;

export const SUBSCRIPTION_FULL = `query subscriptionFull {
  subscriptionAccountByCustomer {
    id isActive cancelled pausedUntil dateCreated isOptInMutable
    delivery {
      type
      address { id firstname lastname street number floor zipcode city phone }
      option { id start end price customizedPrice }
    }
    subscriptionAccountPricing { toPay shipping }
    recurringSubscriptionType { type dishesVariety }
    profiles { id isActive name email price }
  }
  nextSuggestion { id skip validUntil isBeingCharged suggestionPricing { toPay } }
}`;

export const NEXT_SUGGESTION = `query nextSuggestionCli {
  nextSuggestion {
    id skip validUntil isOptIn pausedAt accountIsActive currentOrderStreakProgress
    delivery {
      address { id firstname lastname street number floor zipcode city phone }
      option { id start end price customizedPrice }
    }
    suggestionPricing {
      shipping toPay
      profilesTotal { transactional subscription toPay }
      salesPlan { packageOption { index } }
      appliedVouchers { code appliedDiscount }
    }
    menuMetadata { week year dateFrom dateTo }
    profileSuggestions {
      id profileId skip hasChanges maxPriceWithoutChanges
      profileId
      products {
        id slug name quantity price subscriptionPrice
        category { slug name }
        allergens tags
      }
      productMap { id quantity day }
    }
  }
}`;

export const EDIT_PROFILE_SUGGESTION_MENU = `mutation editProfileSuggestionMenu($profileSuggestionId: ModelId!, $productsInput: [OrderProductMapGraph!]!, $resumeAccountSuggestion: Boolean) {
  editProfileSuggestionProducts(profileSuggestionId: $profileSuggestionId, productsInput: $productsInput, resumeAccountSuggestion: $resumeAccountSuggestion) {
    products { id quantity }
  }
}`;

export const PAUSE_SUGGESTION = `mutation pauseSuggestion($suggestionId: ModelId!, $path: String!, $feedback: String) {
  paused: pauseSuggestion(suggestionId: $suggestionId, path: $path, feedback: $feedback) { id skip }
}`;

export const RESUME_SUGGESTION = `mutation resumeSuggestion($suggestionId: ModelId!) {
  resumed: resumeSuggestion(suggestionId: $suggestionId) { id skip }
}`;

export const CANCEL_SUBSCRIPTION = `mutation cancelSubscriptionAccount($subscriptionAccountId: ModelId!, $path: String!, $pausedWeeks: Int, $feedback: String) {
  subscriptionAccount: cancelSubscriptionAccount(subscriptionAccountId: $subscriptionAccountId, path: $path, pausedWeeks: $pausedWeeks, feedback: $feedback) {
    id isActive pausedUntil
    delivery { option { start end } address { zipcode street } }
  }
}`;

export const ACTIVATE_SUBSCRIPTION = `mutation activateSubscriptionAccount($subscriptionAccountId: ModelId!) {
  subscriptionAccount: activateSubscriptionAccount(subscriptionAccountId: $subscriptionAccountId) {
    id isActive pausedUntil
  }
}`;

export const PENDING_DELIVERY = `query pendingDeliveryCli {
  nextSuggestions {
    id skip validUntil isBeingCharged
    menuMetadata { week year dateFrom }
    suggestionPricing { toPay shipping }
    profileSuggestions { id profileId skip }
  }
  nextDeliveries {
    order {
      id reference state canChange price
      delivery { option { start end } address { zipcode street city } }
      products { id name quantity price subscriptionPrice slug }
    }
    validUntil
    skip
  }
  nextPaymentPendingOrder { id reference state price invoiceUrl }
}`;

export const PREVIOUS_DELIVERIES = `query previousDeliveries($limit: Int!, $offset: Int) {
  previousDeliveries(limit: $limit, offset: $offset) {
    id reference dateCreated price state invoiceUrl
    delivery { option { start end } }
  }
}`;

export const ORDER_DETAILS = `query orderDetails($id: Int!) {
  order(id: $id) {
    id reference state canChange dateCreated price invoiceUrl
    delivery {
      type
      address { firstname lastname street number floor zipcode city phone }
      option { start end price }
    }
    products { id slug name price quantity allergens ingredients }
    profilesProductMap { name products { id quantity day } }
    payments { provider }
  }
}`;

export const CANCEL_ORDER = `mutation cancelConfirmedOrder($orderId: Int!) {
  cancelConfirmedOrder(orderId: $orderId) { amount outcome }
}`;

export const ADDRESSES = `query addresses {
  addresses {
    id firstname lastname street number floor zipcode city phone notes
    isSubscriptionAddress isSuggestionAddress
  }
}`;

export const VOUCHERS = `query customerVouchersCli {
  vouchers(limit: 50, skipExpired: false, skipFuture: false) {
    code dateTo remainingUses isReferral
    discount { price percent maximum }
    subscriptionDiscount { price percent }
    restrict { firstSubscription minimumAmount }
  }
}`;

export const WALLET = `query walletBalance { walletBalance }`;

export const LOGOUT = `query registerLogout { registerLogout }`;
